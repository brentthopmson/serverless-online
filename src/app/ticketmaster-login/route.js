import { NextResponse } from "next/server";
import { geolocation } from "@vercel/functions";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium-min";

import {
  localExecutablePath,
  isDev,
  userAgent,
  remoteExecutablePath,
} from "@/utils/utils";

export const maxDuration = 60; // Max duration: 60 seconds
export const dynamic = "force-dynamic";

const ticketmasterUrl = "https://www.ticketmaster.com";

const selectors = {
  signInNavigationIcon: "button[data-testid='accountLink']",
  emailInput: "input[name='email']",
  passwordInput: "input[name='password']",
  signInButton: "button[name='sign-in'][type='submit']",
};

// Validate login (no changes to this function)
async function validateTicketmasterLogin(email, password) {
  let browser = null;
  let loginStatus = { accountAccess: false };

  try {
    browser = await puppeteer.launch({
      ignoreDefaultArgs: ["--enable-automation"],
      args: isDev
        ? [
            "--disable-blink-features=AutomationControlled",
            "--disable-features=site-per-process",
          ]
        : [...chromium.args, "--disable-blink-features=AutomationControlled"],
      defaultViewport: { width: 1920, height: 1080 },
      executablePath: isDev
        ? localExecutablePath
        : await chromium.executablePath(remoteExecutablePath),
      headless: false,
    });

    const page = (await browser.pages())[0];
    await page.setUserAgent(userAgent);

    await page.goto(ticketmasterUrl, { waitUntil: "load", timeout: 60000 });
    await page.waitForSelector(selectors.signInNavigationIcon, { timeout: 30000 });
    await page.click(selectors.signInNavigationIcon);
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 });

    await page.waitForSelector(selectors.emailInput, { timeout: 30000 });
    await page.type(selectors.emailInput, email, { delay: 100 });

    await page.waitForSelector(selectors.passwordInput, { timeout: 10000 });
    await page.type(selectors.passwordInput, password, { delay: 100 });

    await page.waitForSelector(selectors.signInButton, { timeout: 10000 });
    await page.click(selectors.signInButton);

    const maxWaitTime = 15000;
    const pollingInterval = 500;
    const startTime = Date.now();

    let currentUrl = page.url();
    while (!currentUrl.includes("https://www.ticketmaster.com")) {
      if (Date.now() - startTime > maxWaitTime) break;
      await new Promise((resolve) => setTimeout(resolve, pollingInterval));
      currentUrl = page.url();
    }

    loginStatus.accountAccess = currentUrl.includes("https://www.ticketmaster.com");
  } catch (error) {
    console.error(`Error during Ticketmaster login validation: ${error.message}`);
  } finally {
    if (browser) await browser.close();
  }

  return loginStatus;
}

export async function GET(request) {
  if (isDev) {
    // In local development, skip geolocation logic
    return NextResponse.json(
      { error: "Geolocation not available in local development" },
      { status: 400 }
    );
  }

  const { city, country } = geolocation(request);

  if (!city || !country) {
    return NextResponse.json(
      { error: "Geolocation information unavailable" },
      { status: 400 }
    );
  }

  const url = new URL(request.url);
  const email = url.searchParams.get("email");
  const password = url.searchParams.get("password");

  if (!email || !password) {
    return NextResponse.json({ error: "Missing email or password parameter" }, { status: 400 });
  }

  const loginStatus = await validateTicketmasterLogin(email, password);

  const response = NextResponse.json(
    {
      loginStatus,
      location: { city, country },
    },
    { status: 200 }
  );

  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type");

  return response;
}

export async function OPTIONS() {
  const response = NextResponse.json({}, { status: 200 });
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type");

  return response;
}
