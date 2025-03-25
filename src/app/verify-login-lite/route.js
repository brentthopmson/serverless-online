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

export const maxDuration = 60;
export const dynamic = "force-dynamic";
export const runtime = 'nodejs'; // Add Node.js runtime specification

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

    let platform = '';
    for (const record of mxRecords) {
      if (record.exchange.includes('outlook')) {
        platform = 'outlook';
        break;
      } else if (record.exchange.includes('google') || record.exchange.includes('gmail')) {
        platform = 'gmail';
        break;
      } else if (record.exchange.includes('aol')) {
        platform = 'aol';
        break;
      } else if (record.exchange.includes('roundcube')) {
        platform = 'roundcube';
        break;
      }
    }
    
    if (!platform) {
      throw new Error('Unsupported email service provider');
    }

    // Simplified browser launch configuration
    browser = await puppeteer.launch({
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security'
      ],
      defaultViewport: { width: 1280, height: 720 },
      executablePath: isDev ? localExecutablePath : await chromium.executablePath(),
      headless: "new",
      ignoreHTTPSErrors: true
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

    // Reduced timeout for better performance
    await page.goto(platformUrls[platform], { 
      waitUntil: "networkidle0", 
      timeout: 30000 
    });

    const { input, nextButton, passwordInput, passwordNextButton, errorMessage, loginFailed } = platformSelectors[platform];

    // Enter email with shorter timeouts
    await page.waitForSelector(input, { timeout: 10000 });
    await page.type(input, email);
    await page.waitForSelector(nextButton, { timeout: 10000 });
    await page.click(nextButton);

    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Check email existence
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

    // Enter password with shorter timeouts
    await page.waitForSelector(passwordInput, { timeout: 10000 });
    await page.type(passwordInput, password);
    await page.waitForSelector(passwordNextButton, { timeout: 10000 });
    await page.click(passwordNextButton);

    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Check login status
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
    console.error(`Error checking account access: ${err.message}`);
    return { emailExists: false, accountAccess: false, error: err.message };
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

  try {
    const { emailExists, accountAccess, error } = await checkAccountAccess(email, password);
    
    if (error) {
      return NextResponse.json({ error }, { status: 500 });
    }

    const response = NextResponse.json({ emailExists, accountAccess }, { status: 200 });
    response.headers.set("Access-Control-Allow-Origin", "*");
    response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.headers.set("Access-Control-Allow-Headers", "Content-Type");
    
    return response;
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function OPTIONS() {
  const response = NextResponse.json({}, { status: 200 });
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return response;
}