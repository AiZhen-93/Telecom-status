const fs = require("fs/promises");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomDelay = (minMs, maxMs) => (
  Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs
);

const operators = {
  cht: {
    name: "中華電信",
    url: "https://downdetector.tw/status/chunghwa-telecom-zhong-hua-dian-xin/",
  },
  fet: {
    name: "遠傳電信",
    url: "https://downdetector.tw/status/far-eastone-telecommunications-fet-yuan-chuan-dian-xin/",
  },
  twm: {
    name: "台灣大哥大",
    url: "https://downdetector.tw/status/taiwan-mobile-tai-wan-da-ge-da/",
  },
};

const blockedPatterns = [
  /Performing security verification/i,
  /This website uses a security service/i,
  /verify you are not a bot/i,
  /Just a moment/i,
  /Enable JavaScript and cookies/i,
  /cf-browser-verification/i,
  /challenge-platform/i,
];

const normalPatterns = [
  /User reports show no current problems/i,
  /no current problems/i,
  /運作正常/i,
];

const possibleProblemPatterns = [
  /User reports indicate possible problems/i,
  /possible problems/i,
  /可能發生問題/i,
  /可能有問題/i,
];

const majorProblemPatterns = [
  /User reports indicate problems/i,
  /problems detected/i,
  /current problems/i,
  /currently experiencing problems/i,
  /目前發生問題/i,
  /發生問題/i,
];

function normalizeText(text) {
  return String(text || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&quot;/gi, "\"")
    .replace(/\s+/g, " ")
    .trim();
}

function isBlockedPage(text) {
  return blockedPatterns.some((pattern) => pattern.test(text));
}

function parseNormalText(text) {
  return normalPatterns.some((pattern) => pattern.test(text));
}

function parseProblemState(text) {
  if (normalPatterns.some((pattern) => pattern.test(text))) {
    return {
      level: "green",
      statusTextSource: "normalText",
    };
  }

  if (majorProblemPatterns.some((pattern) => pattern.test(text))) {
    return {
      level: "red",
      statusTextSource: "problemText",
    };
  }

  if (possibleProblemPatterns.some((pattern) => pattern.test(text))) {
    return {
      level: "yellow",
      statusTextSource: "possibleProblemText",
    };
  }

  return {
    level: "green",
    statusTextSource: "unknown",
  };
}

function parseTopProblem(text) {
  const section = text.split(/Most reported problems|最多回報/i)[1]
    ?.split(/Your feedback|How would you rate|您的意見|你會如何評價/i)[0] || "";
  const match = section.match(/(\d{1,3})%\s+(.+?)(?=\s+\d{1,3}%|$)/);
  if (!match) return { label: "", share: 0 };

  return {
    share: Number(match[1]),
    label: match[2].trim().replace(/\s{2,}/g, " "),
  };
}

function extractMessage(text, operatorName) {
  const sentences = [
    ...text.matchAll(/User reports (?:show no current problems|indicate possible problems|indicate problems)[^.。]*[.。]?/gi),
  ].map((match) => match[0].trim());

  const englishMessage = sentences.find((line) =>
    line.toLowerCase().includes(operatorName.toLowerCase()) ||
    /Chunghwa Telecom|Far EasTone|Taiwan Mobile/i.test(line)
  );

  if (englishMessage) return englishMessage;

  const normalIndex = text.search(/運作正常|可能發生問題|目前發生問題|發生問題/);
  if (normalIndex < 0) return "";

  const start = Math.max(0, normalIndex - 80);
  const end = Math.min(text.length, normalIndex + 120);
  return text.slice(start, end).trim();
}

function buildBlockedResult(operator, text, sourceUrl, status) {
  return {
    name: operator.name,
    reachable: false,
    blocked: true,
    normalTextFound: false,
    reports: null,
    latestPointTime: null,
    reportCountSource: "none",
    reportPointCount: 0,
    topProblem: { label: "", share: 0 },
    level: "green",
    message: "",
    sourceUrl,
    httpStatus: status,
    error: "Blocked by Cloudflare verification",
    sample: text.slice(0, 600),
  };
}

async function fetchStatusPage(operator) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(operator.url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      },
    });

    const html = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      url: response.url,
      html,
      text: normalizeText(html),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function scrapeOperator(key, operator) {
  const page = await fetchStatusPage(operator);
  const text = page.text;

  if (isBlockedPage(text)) {
    return buildBlockedResult(operator, text, page.url, page.status);
  }

  if (!page.ok) {
    return {
      name: operator.name,
      reachable: false,
      normalTextFound: false,
      reports: null,
      latestPointTime: null,
      reportCountSource: "none",
      reportPointCount: 0,
      topProblem: { label: "", share: 0 },
      level: "green",
      message: "",
      sourceUrl: page.url,
      httpStatus: page.status,
      error: `HTTP ${page.status}`,
      sample: text.slice(0, 600),
    };
  }

  const normalTextFound = parseNormalText(text);
  const topProblem = parseTopProblem(text);
  const problemState = parseProblemState(text);
  const broadbandOnly =
    /Broadband Internet|寬頻網路/i.test(topProblem.label) &&
    topProblem.share > 30;

  return {
    name: operator.name,
    reachable: true,
    normalTextFound,
    reports: null,
    latestPointTime: null,
    reportCountSource: problemState.statusTextSource,
    reportPointCount: 0,
    topProblem,
    level: broadbandOnly ? "green" : problemState.level,
    message: extractMessage(text, operator.name),
    sourceUrl: page.url,
    httpStatus: page.status,
    sample: text.slice(0, 600),
  };
}

async function main() {
  const result = {
    updated: new Date().toISOString(),
    mode: "status-text-only",
  };

  for (const [key, operator] of Object.entries(operators)) {
    try {
      result[key] = await scrapeOperator(key, operator);
    } catch (error) {
      result[key] = {
        name: operator.name,
        reachable: false,
        normalTextFound: false,
        reports: null,
        latestPointTime: null,
        reportCountSource: "none",
        reportPointCount: 0,
        topProblem: { label: "", share: 0 },
        level: "green",
        message: "",
        error: error.message,
      };
    }

    await sleep(randomDelay(1000, 2500));
  }

  await fs.writeFile(
    "network-status.json",
    JSON.stringify(result, null, 2),
    "utf8"
  );

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
