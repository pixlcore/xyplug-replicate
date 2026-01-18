#!/usr/bin/env node

// xyOps Replicate media generation plugin
// Sends prompt + inputs to Replicate, polls for completion, and downloads output files.

import { glob, readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const API_BASE = "https://api.replicate.com/v1";
const DEFAULT_WAIT_SECONDS = 5;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 300000;

let didExit = false;

// Emit an XYWP message. If final, flush and exit.
function writeJson(payload, exit = false) {
	if (didExit) return;
	const line = `${JSON.stringify(payload)}\n`;
	if (exit) {
		didExit = true;
		process.stdout.write(line, () => process.exit(0));
	}
	else process.stdout.write(line);
}

// Emit an error response and exit.
function fail(code, description) {
	writeJson({ xy: 1, code, description }, true);
	const err = new Error(description || String(code));
	err.xyExit = true;
	throw err;
}

// Read and parse the job payload from STDIN.
async function readJob() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	const raw = chunks.join("").trim();
	if (!raw) return fail("input", "No JSON input received on STDIN.");
	try {
		return JSON.parse(raw);
	}
	catch (err) {
		return fail("input", `Failed to parse JSON input: ${err.message}`);
	}
}

function parseNumber(value, fallback) {
	if (value === undefined || value === null || value === "") return fallback;
	const num = Number(value);
	return Number.isFinite(num) ? num : fallback;
}

function normalizePath(value) {
	return String(value || "")
		.replace(/\\/g, "/")
		.replace(/^\.\/+/, "");
}

function cloneArgs(value) {
	if (!value) return {};
	if (typeof value === "string") {
		const raw = value.trim();
		if (!raw) return {};
		try {
			return JSON.parse(raw);
		}
		catch (err) {
			fail("params", `Failed to parse Custom JSON: ${err.message}`);
		}
	}
	if (typeof value !== "object") return {};
	if (typeof structuredClone === "function") return structuredClone(value);
	return JSON.parse(JSON.stringify(value));
}

function buildInput(params, tool) {
	const input = cloneArgs(params.args);

	if (params.prompt) input.prompt = String(params.prompt);

	if (tool === "image") {
		const width = parseNumber(params.width, undefined);
		const height = parseNumber(params.height, undefined);
		if (Number.isFinite(width)) input.width = Math.round(width);
		if (Number.isFinite(height)) input.height = Math.round(height);

		const numOutputs = parseNumber(params.num_outputs, undefined);
		if (Number.isFinite(numOutputs)) input.num_outputs = Math.round(numOutputs);

		const seed = parseNumber(params.seed, undefined);
		if (Number.isFinite(seed)) input.seed = Math.round(seed);
	}
	else if (tool === "video" || tool === "audio") {
		const duration = parseNumber(params.duration, undefined);
		if (Number.isFinite(duration)) input.duration = duration;

		const seed = parseNumber(params.seed, undefined);
		if (Number.isFinite(seed)) input.seed = Math.round(seed);
	}

	return input;
}

function looksLikeUrl(value) {
	return typeof value === "string" && /^(https?:\/\/|data:)/i.test(value.trim());
}

function collectUrls(value, urls = []) {
	if (looksLikeUrl(value)) {
		urls.push(value.trim());
		return urls;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectUrls(item, urls);
		return urls;
	}
	if (value && typeof value === "object") {
		for (const item of Object.values(value)) collectUrls(item, urls);
	}
	return urls;
}

function extensionFromContentType(contentType) {
	const type = String(contentType || "")
		.toLowerCase()
		.split(";")[0]
		.trim();
	const map = {
		"image/png": "png",
		"image/jpeg": "jpg",
		"image/jpg": "jpg",
		"image/webp": "webp",
		"image/gif": "gif",
		"image/tiff": "tif",
		"video/mp4": "mp4",
		"video/webm": "webm",
		"video/quicktime": "mov",
		"video/x-matroska": "mkv",
		"audio/mpeg": "mp3",
		"audio/mp3": "mp3",
		"audio/wav": "wav",
		"audio/x-wav": "wav",
		"audio/flac": "flac",
		"audio/ogg": "ogg",
		"audio/webm": "webm",
		"audio/aac": "aac",
		"audio/mp4": "m4a"
	};
	return map[type] || "bin";
}

function extensionFromUrl(url) {
	const match = String(url).match(/\.([a-z0-9]{2,5})(?:\?|#|$)/i);
	return match ? match[1].toLowerCase() : "bin";
}

function contentTypeFromFilename(filename) {
	const ext = String(filename).toLowerCase().match(/\.([a-z0-9]+)$/);
	switch (ext ? ext[1] : "") {
		case "png":
			return "image/png";
		case "jpg":
		case "jpeg":
			return "image/jpeg";
		case "webp":
			return "image/webp";
		case "gif":
			return "image/gif";
		case "tif":
		case "tiff":
			return "image/tiff";
		case "mp4":
			return "video/mp4";
		case "mov":
			return "video/quicktime";
		case "webm":
			return "video/webm";
		case "mkv":
			return "video/x-matroska";
		case "mp3":
			return "audio/mpeg";
		case "wav":
			return "audio/wav";
		case "flac":
			return "audio/flac";
		case "ogg":
			return "audio/ogg";
		case "aac":
			return "audio/aac";
		case "m4a":
			return "audio/mp4";
		case "bmp":
			return "image/bmp";
		default:
			return "application/octet-stream";
	}
}

async function requestJson(url, options) {
	let response;
	try {
		response = await fetch(url, options);
	}
	catch (err) {
		fail("network", `Failed to reach Replicate API: ${err.message}`);
	}

	let payload = null;
	const text = await response.text();
	if (text) {
		try {
			payload = JSON.parse(text);
		}
		catch {
			payload = { message: text };
		}
	}

	if (!response.ok) {
		const detail = payload?.detail || payload?.error || payload?.message || "Unknown error.";
		fail("replicate", `Replicate API error (${response.status}): ${detail}`);
	}

	return payload || {};
}

function resolveUploadedFileUrl(payload) {
	const candidates = [
		payload?.urls?.download,
		payload?.urls?.get,
		payload?.url,
		payload?.download_url,
		payload?.href,
		payload?.file
	];

	for (const candidate of candidates) {
		if (looksLikeUrl(candidate)) return candidate.trim();
	}

	if (payload?.id) return `${API_BASE}/files/${payload.id}`;
	return "";
}

async function matchInputFiles(pattern, inputFiles) {
	if (!pattern) return [];
	const normalizedPattern = normalizePath(pattern);
	const patterns = normalizedPattern.includes("/")
		? [normalizedPattern]
		: [normalizedPattern, `**/${normalizedPattern}`];

	const matches = new Set();
	for (const globPattern of patterns) {
		const results = await glob(globPattern, { nodir: true });
		if (Array.isArray(results)) {
			for (const result of results) {
				matches.add(normalizePath(result));
			}
		}
		else if (results && results[Symbol.asyncIterator]) {
			for await (const result of results) {
				matches.add(normalizePath(result));
			}
		}
	}

	if (!matches.size) return [];
	return inputFiles.filter((file) => matches.has(file.normalized));
}

async function uploadFileToReplicate(filePath, apiKey) {
	const filename = basename(filePath);
	let buffer;
	try {
		buffer = await readFile(filePath);
	}
	catch (err) {
		fail("upload", `Failed to read input file '${filePath}': ${err.message}`);
	}

	const contentType = contentTypeFromFilename(filename);
	const form = new FormData();
	form.append("content", new Blob([buffer], { type: contentType }), filename);

	const payload = await requestJson(`${API_BASE}/files`, {
		method: "POST",
		headers: {
			Authorization: `Token ${apiKey}`
		},
		body: form
	});

	const url = resolveUploadedFileUrl(payload);
	if (!url) fail("upload", "Replicate file upload did not return a usable URL.");
	return url;
}

async function resolveFilesInArgs(value, context) {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed.startsWith("files:")) return value;
		const pattern = trimmed.slice(6).trim();
		if (!pattern) return [];

		const matches = await matchInputFiles(pattern, context.inputFiles);
		if (!matches.length) return [];

		const wantsArray = /[*?\[]/.test(pattern);
		const urls = [];
		for (const match of matches) {
			if (!context.uploadCache.has(match.filename)) {
				const url = await uploadFileToReplicate(match.filename, context.apiKey);
				context.uploadCache.set(match.filename, url);
			}
			urls.push(context.uploadCache.get(match.filename));
		}
		if (wantsArray) return urls;
		return urls.length === 1 ? urls[0] : urls;
	}

	if (Array.isArray(value)) {
		const resolved = [];
		for (const item of value) {
			const next = await resolveFilesInArgs(item, context);
			if (Array.isArray(next)) {
				if (next.length) resolved.push(...next);
			}
			else if (next !== undefined) {
				resolved.push(next);
			}
		}
		return resolved;
	}

	if (value && typeof value === "object") {
		const out = Array.isArray(value) ? [] : {};
		for (const [key, item] of Object.entries(value)) {
			out[key] = await resolveFilesInArgs(item, context);
		}
		return out;
	}

	return value;
}

async function waitForCompletion(prediction, options) {
	const { tool, apiKey, pollIntervalMs, timeoutMs } = options;
	const started = Date.now();
	let lastProgress = 0;
	let current = prediction;
	let estWaitTimeMs = (tool == "video") ? 120_000 : ((tool == "audio") ? 15_000 : 30_000);

	while (true) {
		if (!current || !current.status) {
			fail("replicate", "Unexpected response while polling prediction status.");
		}

		switch (current.status) {
			case "succeeded":
				return current;
			case "failed":
				fail("replicate_failed", current.error || "Prediction failed.");
				break;
			case "canceled":
				fail("replicate_canceled", "Prediction was canceled.");
				break;
		}

		const elapsed = Date.now() - started;
		if (elapsed > timeoutMs) {
			fail("timeout", `Prediction timed out after ${Math.round(timeoutMs / 1000)}s.`);
		}

		const progress = Math.min(0.9, 0.1 + (elapsed / estWaitTimeMs) * 0.8);
		if (progress - lastProgress >= 0.05) {
			writeJson({ xy: 1, progress });
			lastProgress = progress;
		}

		await delay(pollIntervalMs);

		const pollUrl = current?.urls?.get || `${API_BASE}/predictions/${current.id}`;
		current = await requestJson(pollUrl, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${apiKey}`
			}
		});
	}
}

async function downloadDataUrl(url, filenamePrefix, index) {
	const match = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/i);
	if (!match) fail("download", "Unsupported data URL format.");
	const contentType = match[1] || "application/octet-stream";
	const isBase64 = Boolean(match[2]);
	const data = match[3] || "";
	const buffer = isBase64 ? Buffer.from(data, "base64") : Buffer.from(decodeURIComponent(data), "utf8");
	const extension = extensionFromContentType(contentType);
	const filename = `${filenamePrefix}-${index + 1}.${extension}`;
	await writeFile(filename, buffer);
	return filename;
}

async function downloadFile(url, apiKey, filenamePrefix, index) {
	if (url.startsWith("data:")) return downloadDataUrl(url, filenamePrefix, index);

	let response;
	try {
		response = await fetch(url, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${apiKey}`
			}
		});
	}
	catch (err) {
		fail("download", `Failed to download output: ${err.message}`);
	}

	if (!response.ok) {
		fail("download", `Failed to download output (${response.status}).`);
	}

	const contentType = response.headers.get("content-type");
	const extension = extensionFromContentType(contentType) !== "bin"
		? extensionFromContentType(contentType)
		: extensionFromUrl(url);
	const filename = `${filenamePrefix}-${index + 1}.${extension}`;
	const buffer = Buffer.from(await response.arrayBuffer());
	await writeFile(filename, buffer);
	return filename;
}

async function main() {
	const job = await readJob();
	const params = job.params || {};
	const tool = params.tool ? String(params.tool) : "image";

	const apiKey = process.env.REPLICATE_API_TOKEN;
	if (!apiKey) fail("env", "Missing Replicate API token. Set REPLICATE_API_TOKEN.");

	const model = String(params.model || "").trim();
	if (!model) fail("params", "Required parameter 'model' was not provided.");

	const prompt = String(params.prompt || "").trim();
	if (!prompt) fail("params", "Required parameter 'prompt' was not provided.");

	const waitSeconds = Math.min(60, Math.max(1, parseNumber(params.wait_seconds, DEFAULT_WAIT_SECONDS)));
	const pollIntervalMs = Math.max(250, parseNumber(params.poll_interval_ms, DEFAULT_POLL_INTERVAL_MS));
	const timeoutMs = Math.max(1000, parseNumber(params.timeout_ms, DEFAULT_TIMEOUT_MS));
	const cancelAfter = params.cancel_after ? String(params.cancel_after).trim() : "";

	const input = buildInput({ ...params, prompt }, tool);
	const inputFiles = Array.isArray(job.input?.files) ? job.input.files : [];
	const normalizedFiles = inputFiles
		.filter((entry) => entry && entry.filename)
		.map((entry) => ({
			filename: String(entry.filename),
			normalized: normalizePath(entry.filename)
		}));

	writeJson({ xy: 1, progress: 0.05 });

	const context = {
		apiKey,
		inputFiles: normalizedFiles,
		uploadCache: new Map()
	};
	const resolvedInput = await resolveFilesInArgs(input, context);
	Object.keys(input).forEach((key) => delete input[key]);
	Object.assign(input, resolvedInput);

	const headers = {
		Authorization: `Bearer ${apiKey}`,
		"Content-Type": "application/json",
		Prefer: `wait=${waitSeconds}`
	};
	if (cancelAfter) headers["Cancel-After"] = cancelAfter;

	const prediction = await requestJson(`${API_BASE}/predictions`, {
		method: "POST",
		headers,
		body: JSON.stringify({ version: model, input })
	});

	writeJson({ xy: 1, progress: 0.1 });

	const finalPrediction = await waitForCompletion(prediction, {
		tool,
		apiKey,
		pollIntervalMs,
		timeoutMs
	});

	const outputUrls = collectUrls(finalPrediction.output || []);
	if (!outputUrls.length) {
		fail("output", "Prediction succeeded but returned no output URLs.");
	}

	writeJson({ xy: 1, progress: 0.9 });

	const filenamePrefix = `replicate-${finalPrediction.id}`;
	const files = [];
	for (let i = 0; i < outputUrls.length; i++) {
		const filename = await downloadFile(outputUrls[i], apiKey, filenamePrefix, i);
		files.push(filename);
	}

	writeJson({
		xy: 1,
		code: 0,
		data: {
			prediction_id: finalPrediction.id,
			model: finalPrediction.model,
			version: finalPrediction.version,
			status: finalPrediction.status,
			metrics: finalPrediction.metrics || {},
			output: finalPrediction.output
		},
		files
	}, true);
}

main().catch((err) => {
	if (didExit || err?.xyExit) return;
	writeJson({ xy: 1, code: "exception", description: err?.message || String(err) }, true);
});
