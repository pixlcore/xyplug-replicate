#!/usr/bin/env node

// xyOps Replicate image generation plugin
// Sends prompt + inputs to Replicate, polls for completion, and downloads output files.

import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

const API_BASE = "https://api.replicate.com/v1";
const DEFAULT_WAIT_SECONDS = 5;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 300000;

// Emit an XYWP message. If final, flush and exit.
function writeJson(payload, exit = false) {
	const line = `${JSON.stringify(payload)}\n`;
	if (exit) process.stdout.write(line, () => process.exit(0));
	else process.stdout.write(line);
}

// Emit an error response and exit.
function fail(code, description) {
	writeJson({ xy: 1, code, description }, true);
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

function buildInput(params) {
	const input = params.args || {};

	if (params.prompt) input.prompt = String(params.prompt);
	if (params.negative_prompt) input.negative_prompt = String(params.negative_prompt);

	const width = parseNumber(params.width, undefined);
	const height = parseNumber(params.height, undefined);
	if (Number.isFinite(width)) input.width = Math.round(width);
	if (Number.isFinite(height)) input.height = Math.round(height);

	if (params.aspect_ratio) input.aspect_ratio = String(params.aspect_ratio);

	const numOutputs = parseNumber(params.num_outputs, undefined);
	if (Number.isFinite(numOutputs)) input.num_outputs = Math.round(numOutputs);

	const seed = parseNumber(params.seed, undefined);
	if (Number.isFinite(seed)) input.seed = Math.round(seed);

	const guidance = parseNumber(params.guidance, undefined);
	if (Number.isFinite(guidance)) input.guidance = guidance;

	const steps = parseNumber(params.steps, undefined);
	if (Number.isFinite(steps)) input.steps = Math.round(steps);

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
		"image/gif": "gif"
	};
	return map[type] || "bin";
}

function extensionFromUrl(url) {
	const match = String(url).match(/\.([a-z0-9]{2,5})(?:\?|#|$)/i);
	return match ? match[1].toLowerCase() : "bin";
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

async function waitForCompletion(prediction, options) {
	const { apiKey, pollIntervalMs, timeoutMs } = options;
	const started = Date.now();
	let lastProgress = 0;
	let current = prediction;

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

		const progress = Math.min(0.9, 0.1 + (elapsed / 30_000) * 0.8);
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

(async () => {
	const job = await readJob();
	const params = job.params || {};

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

	const input = buildInput({ ...params, prompt });

	writeJson({ xy: 1, progress: 0.05 });

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
})();
