const puppeteer = require("puppeteer");
const fs = require("fs/promises");

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

function parseNormalText(text) {
  return (
    text.includes("運作正常") ||
    text.includes("no current problems") ||
    text.includes("User reports show no current problems")
  );
}

function isBlockedPage(text) {
  return (
    text.includes("Performing security verification") ||
    text.includes("This website uses a security service") ||
    text.includes("Cloudflare") ||
    text.includes("Just a moment") ||
    text.includes("Enable JavaScript and cookies")
  );
}

function extractReportPoints(html) {
  const points = [];
  const now = Date.now();
  const numericPairPattern = /\[\s*(\d{10,13})\s*,\s*(\d{1,6})\s*\]/g;
  const objectPointPattern = /["']?(?:x|date|time|timestamp)["']?\s*:\s*(\d{10,13})\s*,\s*["']?(?:y|value|count|reports)["']?\s*:\s*(\d{1,6})/g;
  let match;

  while ((match = numericPairPattern.exec(html))) {
    const timestamp = Number(match[1]);
    const count = Number(match[2]);
    points.push({
      timestamp: timestamp < 1000000000000 ? timestamp * 1000 : timestamp,
      count,
    });
  }

  while ((match = objectPointPattern.exec(html))) {
    const timestamp = Number(match[1]);
    const count = Number(match[2]);
    points.push({
      timestamp: timestamp < 1000000000000 ? timestamp * 1000 : timestamp,
      count,
    });
  }

  const deduped = new Map();
  points
    .filter((point) =>
      Number.isFinite(point.timestamp) &&
      Number.isFinite(point.count) &&
      point.timestamp > now - 25 * 60 * 60 * 1000 &&
      point.timestamp < now + 10 * 60 * 1000
    )
    .forEach((point) => {
      deduped.set(`${point.timestamp}:${point.count}`, point);
    });

  return [...deduped.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function parseLatestReportPoint(html) {
  const points = extractReportPoints(html);
  const latestPoint = points[points.length - 1];

  if (!latestPoint) {
    return {
      reports: 0,
      latestPointTime: null,
    };
  }

  return {
    reports: latestPoint.count,
    latestPointTime: new Date(latestPoint.timestamp).toISOString(),
  };
}

function parseTopProblem(text) {
  const section = text.split(/Most reported problems|最多回報/i)[1]?.split(/Your feedback|How would you rate|您的意見|你會如何評價/i)[0] || "";
  const match = section.match(/(\d{1,3})%\s+(.+?)(?=\s+\d{1,3}%|$)/);
  if (!match) return { label: "", share: 0 };

  return {
    share: Number(match[1]),
    label: match[2].trim().replace(/\s{2,}/g, " "),
  };
}

function decideLevel({ normalTextFound, reports, topProblem }) {
  const broadbandOnly =
    /Broadband Internet|寬頻網路/i.test(topProblem.label) &&
    topProblem.share > 30;

  if (broadbandOnly) return "green";
  if (reports > 100) return "red";
  if (reports > 10) return "yellow";
  if (normalTextFound) return "green";
  return "green";
}

async function scrapeOperator(page, key, operator) {
  await page.goto(operator.url, {
    waitUntil: "networkidle2",
    timeout: 60000,
  });

  const { text, html } = await page.evaluate(() => ({
    text: document.body.innerText,
    html: document.body.innerHTML,
  }));
  if (isBlockedPage(text)) {
    return {
      name: operator.name,
      reachable: false,
      blocked: true,
      normalTextFound: false,
      reports: null,
      latestPointTime: null,
      topProblem: { label: "", share: 0 },
      level: "green",
      message: "",
      error: "Blocked by Cloudflare verification",
      sample: text.slice(0, 600),
    };
  }
  const normalTextFound = parseNormalText(text);
  const { reports, latestPointTime } = parseLatestReportPoint(html);
  const topProblem = parseTopProblem(text);
  const level = decideLevel({ normalTextFound, reports, topProblem });

  return {
    name: operator.name,
    reachable: true,
    normalTextFound,
    reports,
    latestPointTime,
    topProblem,
    level,
    message: text.split("\n").find((line) =>
      line.includes("no current problems") || line.includes("運作正常")
    ) || "",
    sample: text.slice(0, 600),
  };
}

async function main() {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const page = await browser.newPage();

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
  );

  const result = {
    updated: new Date().toISOString(),
  };

  for (const [key, operator] of Object.entries(operators)) {
    try {
      result[key] = await scrapeOperator(page, key, operator);
    } catch (error) {
      result[key] = {
        name: operator.name,
        reachable: false,
        normalTextFound: false,
        reports: null,
        latestPointTime: null,
        topProblem: { label: "", share: 0 },
        level: "green",
        message: "",
        error: error.message,
      };
    }
  }

  await browser.close();

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
