import { mkdirSync, createWriteStream, readFileSync, readdir } from 'fs';
import { resolve, basename } from 'path';
import { Page } from 'puppeteer';
import * as puppeteer from 'puppeteer';
import * as request from 'request';
import * as prompt from 'prompt';

type EmojiList = Record<string, string>;
// sudo docker run --name emoji --rm -it -v $PWD:/home/node/app ccitro/node-chrome-headless /bin/bash

interface UserInput {
    host: string;
    email: string;
    password: string;
    show: boolean;
}

if (process.argv.length < 3) {
    console.log('usage: slack-emoji-import path/to/emoji-pack[.json]');
    process.exit(1);
}

const TYPING_DELAY = 20;
const TEMP_DIR = resolve(__dirname, '.tmp');
const ENTRY_URL_FACTORY = host => `https://${host}.slack.com/?redir=%2Fcustomize%2Femoji`;
const EMOJI_SOURCE_PATH = resolve(process.cwd(), process.argv[2]);

try {
    mkdirSync(TEMP_DIR);
} catch (e) { }

start();

/**
 * 
 */
async function start(): Promise<void> {
    const userInput = await getUserInput();

    console.log('Launching browser...');
    const browser = await puppeteer.launch({ 
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
        headless: !userInput.show, defaultViewport: { width: 1200, height: 1000 } 
    });
    const browserCtx = await browser.createIncognitoBrowserContext();
    const page = await browserCtx.newPage();

    console.log('logging in...')
    await login(page, userInput);
    console.log('logged in.');

    const emojiPack = await loadEmojiPack(EMOJI_SOURCE_PATH);
    for (let name in emojiPack) {
        const url = emojiPack[name];
        console.log(`Processing: ${name} / ${url}`)
        if (url.startsWith("alias:")) {
            console.log("Skipping alias");
            continue;
        }
        let imagePath: string;
    
        if (url.includes('://')) {
            console.log(`downloading ${name}...`);
            imagePath = await downloadImage(url);
            console.log(`downloaded  ${name}.`);
        } else {
            imagePath = url
            console.log(`using local file for ${name}.`);
        }

        console.log(`uploading ${name}...`);
        try {
            await upload(page, imagePath, name).then(sleep(100));
        } catch (err) {
            console.error("Error uploading", err);
            await page.reload();
        }
        console.log(`uploaded  ${name}.`);
    }
    console.log(' ');
    console.log(`Uploaded ${emojiPack.emojis.length} emojis.`);

    await browser.close();
}

/**
 * 
 */
function getUserInput(): Promise<UserInput> {
    return new Promise((promiseResolve, promiseReject) => {
        prompt.get([
            {
                description: 'Slack Host',
                name: 'host',
                required: true
            },
            {
                description: 'Slack login email',
                name: 'email',
                required: true
            },
            {
                description: 'Slack password',
                name: 'password',
                hidden: true,
                required: true
            },
            {
                description: 'Show browser',
                name: 'show',
                type: 'boolean',
                default: false,
                required: false
            },
        ],
            (err, result) => err ? promiseReject(err) : promiseResolve(result),
        )
    });
}

/**
 * 
 */
async function login(page: Page, userInput: UserInput): Promise<void> {
    await page.goto(ENTRY_URL_FACTORY(userInput.host));

    const emailInputSelector = '#signin_form input[type=email]';
    await page.waitForSelector(emailInputSelector, { visible: true }).then(sleep(500));
    
    await setInputElementValue(page, emailInputSelector, userInput.email);

    await setInputElementValue(page, '#signin_form input[type=password]', userInput.password);

    const signinButtonElement = await page.$('#signin_form #signin_btn');
    await signinButtonElement.click();

    await page.waitForSelector(emailInputSelector, { hidden: true });

}

/**
 * 
 */
function loadEmojiPack(path: string): Promise<EmojiList> {
    return new Promise((promiseResolve, promiseReject) => {
        const emojiPath = resolve(__dirname, 'emoji', path);
        if (EMOJI_SOURCE_PATH.toLowerCase().endsWith('.json')) {
            const jsonContent = readFileSync(emojiPath).toString();
            let emojiData = {} as Record<string, string>;
            try {
                emojiData = JSON.parse(jsonContent);
                if (!emojiData || !(Object.keys(emojiData))) {
                    throw new Error("Invalid json data");
                }
                promiseResolve(emojiData);
            } catch (err) {
                promiseReject(new Error("Unable to parse JSON"));
                return;
            }
        } else {
            readdir(emojiPath, (error, files) => {
                if (error) {
                    promiseReject(new Error('Unable to read emoji directory.'));
                    return;
                }
                if (!files || files.length < 1) {
                    promiseReject(new Error('Directory does not contain any files.'));
                    return;
                }
                const emojis = files
                    .filter(file => !!file.match(/\.jpg|gif|png|jpeg$/i))
                    .reduce((acc, file) => {
                        const src = resolve(emojiPath, file);
                        const name = file.replace(/^(.*)\..*$/, '$1');
                        acc[name] = src;
                        return acc;
                    }, {} as Record<string, string>);
                promiseResolve(emojis);
            });
        }
    });
}

/**
 * 
 */
function downloadImage(url: string): Promise<string> {

    return new Promise((promiseResolve, promiseReject) => {

        if (!/^https?:\/\//.test(url)) {
            promiseReject(new Error(`Invalid url ${url}`));
        }

        const target = resolve(TEMP_DIR, basename(url));
        request(url).pipe(createWriteStream(target)).on('finish', () => promiseResolve(target));

    });

}

/**
 * 
 */
async function upload(page: Page, imagePath: string, name: string): Promise<void> {
    console.log("Starting button wait evaluate");
    await page.evaluate(async () => {

        let count = 0;
        let addEmojiButtonSelector = ".p-customize_emoji_wrapper__custom_button";
        // Wait for emoji button to appear
        while (!document.querySelector(addEmojiButtonSelector)) {
            count++;
            if (count > 10) {
                throw new Error("Gave up waiting for button")
            }
            await new Promise(r => setTimeout(r, 500));
        }
        let buttonClassName = addEmojiButtonSelector.substring(1, addEmojiButtonSelector.length);
        const addEmojiButtonElement = <HTMLElement>document.getElementsByClassName(buttonClassName)[0];

        if (!addEmojiButtonElement)
            throw new Error('Add Emoji Button not found');

        addEmojiButtonElement.click();
    });

    console.log("Waiting for file input");
    const fileInputElement = await page.waitForSelector('input#emojiimg');
    console.log("Calling uploadFile");
    await fileInputElement.uploadFile(imagePath);

    console.log("Setting emoji name");
    await setInputElementValue(page, '#emojiname', name);

    const saveEmojiButtonSelector = '.c-sk-modal_footer_actions .c-button--primary';
    console.log("Waiting for save button");
    const saveEmojiButtonElement = await page.waitForSelector(saveEmojiButtonSelector, { timeout: 500 });
    console.log("Clicking save button");
    await saveEmojiButtonElement.click();

    await sleep(500);
    console.log("Checking for error");
    let errorFound = false;
    try {
        await page.waitForSelector(saveEmojiButtonSelector, { hidden: true, timeout: 500 });
        errorFound = false;
        console.log("No error found!");
    } catch(err) {
        errorFound = true;
    }

    if (errorFound) {
        console.log("Error found, clicking cancel");
        const cancelEmojiButtonSelector = '.c-sk-modal_footer_actions .c-button--outline';
        console.log("Waiting for cancel button");
        const cancelEmojiButtonElement = await page.waitForSelector(cancelEmojiButtonSelector, {timeout: 500});
        console.log("Clicking cancel button");
        await cancelEmojiButtonElement.click();
    }

    console.log("Waiting for dialog to hide");
    await page.waitForSelector(saveEmojiButtonSelector, { hidden: true, timeout: 1000 });
    console.log("Complete");
}

/**
 * 
 */
async function setInputElementValue(page: Page, querySelector: string, value: string) {
    const element = await page.waitForSelector(querySelector);
    // clear existing value
    await page.focus(querySelector);
    await page.keyboard.press('Home');
    await page.keyboard.down('Shift');
    await page.keyboard.press('End');
    await page.keyboard.up('Shift');
    await page.keyboard.press('Backspace');
    // enter new value
    await element.type(value, { delay: TYPING_DELAY });
}

/**
 * Adds delay to promise chain
 */
function sleep(time: number): () => Promise<void> {
    return () => new Promise(resolve => setTimeout(() => resolve(), time));
}
