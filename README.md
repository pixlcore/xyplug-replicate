<p align="center"><img src="https://raw.githubusercontent.com/pixlcore/xyplug-replicate/refs/heads/main/logo.png" height="120" alt="Replicate"/></p>
<h1 align="center">Replicate AI Generation Plugin</h1>

Generate images, video, or audio using the [Replicate](https://replicate.com) API, and return the results to the [xyOps Workflow Automation System](https://xyops.io) as attached job files.

## Requirements

- **Node.js + npx**
	- Required to run the plugin via `npx`.
- **git**
	- Required if you run the plugin via the GitHub `npx` install path.

## Environment Variables

Create a [Secret Vault](https://xyops.io/docs/secrets) in xyOps and assign this Plugin to it. Add the following variable:

- `REPLICATE_API_TOKEN`

## Plugin Parameters

The plugin uses a **Tool Select** menu to switch between three modes: **Generate Images**, **Generate Video**, and **Generate Audio**. Each tool shares a **Custom JSON** field that can include model-specific parameters.

### Generate Images

- **Replicate Model**: Model or version identifier. Examples:
	- `google/nano-banana-pro`
	- `owner/model:version_id`
	- `version_id`
- **Prompt**: Text prompt for the image.
- **Width / Height**: Optional output size in pixels (if supported by the model).
- **Num Outputs**: Optional number of images to generate.
- **Seed**: Optional seed for reproducible results.
- **Custom JSON**: Optional JSON object merged into the model input.
- **Timeout (ms)**: Overall timeout for the prediction.

Default Custom JSON includes `"image_input": "files:*"` so any input files passed to the job can be mapped into `image_input`.

### Generate Video

- **Replicate Model**: Default `google/veo-3.1`.
- **Prompt**: Text prompt for the video.
- **Duration**: Duration in seconds (model dependent).
- **Seed**: Optional seed for reproducible results.
- **Custom JSON**: Optional JSON object merged into the model input (pre-filled with Veo defaults and file-mapping placeholders).
- **Timeout (ms)**: Overall timeout for the prediction.

### Generate Audio

- **Replicate Model**: Default `stability-ai/stable-audio-2.5`.
- **Prompt**: Text prompt for the audio.
- **Duration**: Duration in seconds (model dependent).
- **Seed**: Optional seed for reproducible results.
- **Custom JSON**: Optional JSON object merged into the model input.
- **Timeout (ms)**: Overall timeout for the prediction.

### File Inputs via Custom JSON

Any Custom JSON value that starts with `files:` is treated as a glob against the job input files. The plugin uploads matching files to Replicate and replaces the value with the resulting URL(s). If no files match, the value becomes an empty array.

Example (video reference images):

```json
{
	"reference_images": "files:*.png",
	"image": "files:first-frame.jpg",
	"last_frame": ""
}
```

## Usage Example

Example parameters for **Generate Images**:

```
Tool Select: Generate Images
Model: google/nano-banana-pro
Prompt: A playful robot barista pouring latte art in a sunlit cafe.
Width: 1024
Height: 1024
Num Outputs: 2
Seed: 12345
```

## Output

The generated media is downloaded from Replicate and attached to the job as files. The job `data` payload includes the prediction ID, model, metrics, and full output payload from Replicate.

## Local Testing

When invoked by xyOps the script expects JSON input via STDIN. You can simulate this locally by echoing a JSON payload into the script.

Example input:

```json
{
	"params": {
		"tool": "image",
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
echo '{ "params": { "tool": "image", "model": "google/nano-banana-pro", "prompt": "A sleek drone hovering over a foggy forest at sunrise." } }' | node index.js
```

## Data Collection

This plugin does not collect or transmit any data outside of the Replicate API. Replicate may collect usage metrics according to its own terms.

## License

MIT
