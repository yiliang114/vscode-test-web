/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs, existsSync } from 'fs';
import * as path from 'path';

import * as https from 'https';
import * as http from 'http';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';
import { URL } from 'url';

import { Static } from './main';

interface DownloadInfo {
	url: string;
	version: string;
}

async function getLatestVersion(quality: 'stable' | 'insider'): Promise<DownloadInfo> {
	const update: DownloadInfo = await fetchJSON(`https://update.code.visualstudio.com/api/update/web-standalone/${quality}/latest`);
	return update;
}

const reset = '\x1b[G\x1b[0K';

async function downloadAndUntar(downloadUrl: string, destination: string, message: string): Promise<void> {
	process.stdout.write(message);

	if (!existsSync(destination)) {
		await fs.mkdir(destination, { recursive: true });
	}

	const tar = await import('tar-fs');
	const gunzip = await import('gunzip-maybe');

	return new Promise((resolve, reject) => {
		const httpLibrary = downloadUrl.startsWith('https') ? https : http;

		httpLibrary.get(downloadUrl, getAgent(downloadUrl), res => {
			const total = Number(res.headers['content-length']);
			let received = 0;
			let timeout: NodeJS.Timeout | undefined;

			res.on('data', chunk => {
				if (!timeout) {
					timeout = setTimeout(() => {
						process.stdout.write(`${reset}${message}: ${received}/${total} (${(received / total * 100).toFixed()}%)`);
						timeout = undefined;
					}, 100);
				}

				received += chunk.length;
			});
			res.on('end', () => {
				if (timeout) {
					clearTimeout(timeout);
				}

				process.stdout.write(`${reset}${message}: complete\n`);
			});


			const extract = res.pipe(gunzip()).pipe(tar.extract(destination, { strip: 1 }));
			extract.on('finish', () => {
				process.stdout.write(`Extracted to ${destination}\n`);
				resolve();
			});
			extract.on('error', reject);
		});
	});
}

export async function downloadAndUnzipVSCode(quality: 'stable' | 'insider', vscodeTestDir: string): Promise<Static> {
	const info = await getLatestVersion(quality);

	const folderName = `vscode-web-${quality}-${info.version}`;

	const downloadedPath = path.resolve(vscodeTestDir, folderName);
	if (existsSync(downloadedPath) && existsSync(path.join(downloadedPath, 'version'))) {
		return { type: 'static', location: downloadedPath, quality, version: info.version };
	}

	if (existsSync(vscodeTestDir)) {
		await fs.rmdir(vscodeTestDir, { recursive: true, maxRetries: 5 });
	}

	await fs.mkdir(vscodeTestDir, { recursive: true });

	const productName = `VS Code ${quality === 'stable' ? 'Stable' : 'Insiders'}`;

	try {
		await downloadAndUntar(info.url, downloadedPath, `Downloading ${productName}`);
		await fs.writeFile(path.join(downloadedPath, 'version'), folderName);
	} catch (err) {
		console.error(err);
		throw Error(`Failed to download and unpack ${productName}`);
	}
	return { type: 'static', location: downloadedPath, quality, version: info.version };
}

export async function fetch(api: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const httpLibrary = api.startsWith('https') ? https : http;
		httpLibrary.get(api, getAgent(api), res => {
			if (res.statusCode !== 200) {
				reject('Failed to get content from ');
			}

			let data = '';

			res.on('data', chunk => {
				data += chunk;
			});

			res.on('end', () => {
				resolve(data);
			});

			res.on('error', err => {
				reject(err);
			});
		});
	});
}

export async function fetchJSON<T>(api: string): Promise<T> {
	const data = await fetch(api);
	try {
		return JSON.parse(data);
	} catch (err) {
		throw new Error(`Failed to parse response from ${api}`);
	}
}

let PROXY_AGENT: HttpProxyAgent<string> | undefined = undefined;
let HTTPS_PROXY_AGENT: HttpsProxyAgent<string> | undefined = undefined;

if (process.env.npm_config_proxy) {
	PROXY_AGENT = new HttpProxyAgent(process.env.npm_config_proxy);
	HTTPS_PROXY_AGENT = new HttpsProxyAgent(process.env.npm_config_proxy);
}
if (process.env.npm_config_https_proxy) {
	HTTPS_PROXY_AGENT = new HttpsProxyAgent(process.env.npm_config_https_proxy);
}

function getAgent(url: string): https.RequestOptions {
	const parsed = new URL(url);
	const options: https.RequestOptions = {};
	if (PROXY_AGENT && parsed.protocol.startsWith('http:')) {
		options.agent = PROXY_AGENT;
	}

	if (HTTPS_PROXY_AGENT && parsed.protocol.startsWith('https:')) {
		options.agent = HTTPS_PROXY_AGENT;
	}

	return options;
}

export async function directoryExists(path: string): Promise<boolean> {
	try {
		const stats = await fs.stat(path);
		return stats.isDirectory();
	} catch {
		return false;
	}
}

export async function fileExists(path: string): Promise<boolean> {
	try {
		const stats = await fs.stat(path);
		return stats.isFile();
	} catch {
		return false;
	}
}
