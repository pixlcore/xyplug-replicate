<p align="center"><img src="https://raw.githubusercontent.com/pixlcore/xyplug-replicate/refs/heads/main/logo.png" height="120" alt="Replicate"/></p>
<h1 align="center">Replicate Image Generation Plugin</h1>

Generate one or more images using the [Replicate](https://replicate.com) API, and return them to the [xyOps Workflow Automation System](https://xyops.io) as attached job files.

## Requirements

- **Node.js + npx**
	- Required to run the plugin via `npx`.
- **git**
	- Required if you run the plugin via the GitHub `npx` install path.

## Environment Variables

Create a [Secret Vault](https://xyops.io/docs/secrets) in xyOps and assign this Plugin to it. Add the following variable:

- `REPLICATE_API_TOKEN`

## Plugin Parameters

Replicate models vary, so this plugin provides common image fields plus an **Input JSON** override for advanced model inputs.

- **Model**: Replicate model or version identifier. Examples:
	- `google/nano-banana-pro`
	- `owner/model:version_id`
	- `version_id`
- **Prompt**: Text prompt for the image.
- **Negative Prompt**: Optional negative prompt.
- **Width / Height**: Optional output size in pixels (if supported by the model).
- **Aspect Ratio**: Optional aspect ratio string (if supported by the model).
- **Num Outputs**: Optional number of images to generate.
- **Seed**: Optional seed for reproducible results.
- **Guidance / Steps**: Optional model tuning parameters.
- **Input JSON**: Optional JSON object to merge into the model input. Prompt fields above take precedence.
- **Wait Seconds**: How long to wait synchronously for the prediction (1-60 seconds).
- **Poll Interval (ms)**: How often to poll Replicate after the initial request.
- **Timeout (ms)**: Overall timeout for the prediction.
- **Cancel After**: Optional Replicate `Cancel-After` duration (e.g. `5m`, `120s`).

## Usage Example

Example parameters:

```
Model: google/nano-banana-pro
Prompt: A playful robot barista pouring latte art in a sunlit cafe.
Width: 1024
Height: 1024
Num Outputs: 2
Seed: 12345
Wait Seconds: 60
Timeout (ms): 300000
```

Model-specific inputs can be supplied using **Input JSON**:

```
{
	"guidance": 3,
	"steps": 30,
	"aspect_ratio": "1:1"
}
```

## Output

The generated images are downloaded from Replicate and attached to the job as files. The job `data` payload includes the prediction ID, model, metrics, and full output payload from Replicate.

## Local Testing

When invoked by xyOps the script expects JSON input via STDIN. You can simulate this locally by echoing a JSON payload into the script.

Example input:

```json
{
	"params": {
		"model": "google/nano-banana-pro",
		"prompt": "A sleek drone hovering over a foggy forest at sunrise.",
		"width": 1024,
		"height": 1024,
		"num_outputs": 1
	}
}
```

Example command:

```sh
export REPLICATE_API_TOKEN="your-token-here"
echo '{ "params": { "model": "google/nano-banana-pro", "prompt": "A sleek drone hovering over a foggy forest at sunrise." } }' | node index.js
```

## Data Collection

This plugin does not collect or transmit any data outside of the Replicate API. Replicate may collect usage metrics according to its own terms.

## License

MIT
