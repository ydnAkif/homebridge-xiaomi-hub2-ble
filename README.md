# homebridge-xiaomi-hub2-ble

Homebridge plugin for Xiaomi Smart Home Hub 2 BLE temperature and humidity sensors via Xiaomi Cloud.

## Quick Start

1. Get your Xiaomi Cloud credentials: `userId`, `ssecurity`, and `serviceToken`.
2. Find the DID value for each BLE sensor you want to expose.
3. Add the platform config to your Homebridge `config.json`.
4. In the project directory, run:

```bash
npm install
npm link
sudo npm link homebridge-xiaomi-hub2-ble
sudo hb-service restart
```

5. Check Homebridge logs and confirm that the sensors appear in HomeKit.

## State

Tested on Raspberry Pi + Homebridge and confirmed working.

## Requirements

- Node.js 18+
- Homebridge 1.6.0+
- Python 3.9+ (for Xiaomi token extraction)
- Python `venv` support
- `git` (to clone the token extractor repository)
- Xiaomi Cloud credentials:
  - userId
  - ssecurity
  - serviceToken
- Sensor DID values

## Installation

This is a local development / manual installation flow using `npm link`.

If you are running Homebridge manually, edit the Homebridge config file directly.
If you are using Homebridge UI, add the platform config from the UI config editor.

Common config file location:

```bash
~/.homebridge/config.json
```

In the project directory:

```bash
npm install
npm link
sudo npm link homebridge-xiaomi-hub2-ble
```

Restart the Homebridge service:

```bash
sudo hb-service restart
```

## Getting Xiaomi Cloud Credentials

You can retrieve them using `token_extractor.py`.

Direct download link:

- https://github.com/PiotrMachowski/Xiaomi-cloud-tokens-extractor/releases/download/v1.5.1/token_extractor.zip

Download and run it:

```bash
curl -L -o token_extractor.zip https://github.com/PiotrMachowski/Xiaomi-cloud-tokens-extractor/releases/download/v1.5.1/token_extractor.zip
unzip token_extractor.zip
cd token_extractor
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install --upgrade pip
python3 -m pip install -r requirements.txt
```

This keeps the Python dependencies isolated from your system Python installation.

Before running `python3 token_extractor.py`, edit `token_extractor.py` and add the following lines right below this block:

```python
if logged:
  print_if_interactive(f"{Fore.GREEN}Logged in.")
  print("USER_ID:", connector.userId)
  print("SSECURITY:", connector._ssecurity)
  print("SERVICE_TOKEN:", connector._serviceToken)
```

Then run:

```bash
python3 token_extractor.py
```

In the tested flow, `token_extractor.py` proceeds interactively step by step:

1. Enter your Xiaomi cloud username.
2. Enter your Xiaomi cloud password.
3. A browser window opens on localhost for the security verification step. Complete it and enter the requested security code back in the terminal.
4. Xiaomi then sends a 2FA code to your email. Enter that code in the terminal.
5. If authentication succeeds, continue through the prompts. When the script reaches the device selection / final prompt in your tested flow, leaving it blank returns the account and device information.
6. Because of the added `print(...)` lines, the script will also print `USER_ID`, `SSECURITY`, and `SERVICE_TOKEN`.

The `SERVICE_TOKEN` value is expected to be very long.

When you are done, you can leave the virtual environment with:

```bash
deactivate
```

Use these values in your Homebridge config.

## Getting Sensor DID Values

You need one unique `did` value for each sensor.

- Each sensor entry in the `sensors` array must use its own DID.
- Do not reuse the same DID for multiple sensors unless they are actually the same device.
- The DID must match the Xiaomi account and region you use in this plugin.

If your Xiaomi Cloud extraction workflow or other Xiaomi Cloud tools list device IDs, use those values as the `did` field in the Homebridge config.

## Homebridge config.json Example

Add the following platform block under `platforms`:

```json
{
  "platform": "XiaomiHub2BLE",
  "name": "Xiaomi Hub 2 BLE",
  "country": "tw",
  "userId": "YOURUSERID",
  "ssecurity": "YOURSSECURITY",
  "serviceToken": "YOURSERVICETOKEN",
  "pollInterval": 120,
  "sensors": [
    {
      "name": "Bedroom 1",
      "did": "YOURDEVICEID",
      "model": "miaomiaoce.sensor_ht.t2"
    },
    {
      "name": "Bedroom 2",
      "did": "YOURDEVICEID",
      "model": "miaomiaoce.sensor_ht.t2"
    },
    {
      "name": "Bedroom 3",
      "did": "YOURDEVICEID",
      "model": "miaomiaoce.sensor_ht.t2"
    },
    {
      "name": "Hallway",
      "did": "YOURDEVICEID",
      "model": "miaomiaoce.sensor_ht.t2"
    },
    {
      "name": "Livingroom",
      "did": "YOURDEVICEID",
      "model": "miaomiaoce.sensor_ht.t2"
    },
    {
      "name": "Kitchen",
      "did": "YOURDEVICEID",
      "model": "miaomiaoce.sensor_ht.t2"
    },
    {
      "name": "Bathroom",
      "did": "YOURDEVICEID",
      "model": "miaomiaoce.sensor_ht.t2"
    },
    {
      "name": "WC",
      "did": "YOURDEVICEID",
      "model": "miaomiaoce.sensor_ht.t2"
    }
  ]
}
```

The `model` field is optional. If omitted, the plugin uses `miaomiaoce.sensor_ht.t2` by default.

## Notes

- `pollInterval` minimum is 60 seconds. Recommended value is 120 seconds or higher.
- `country` may vary based on your Xiaomi account region (for example: `tw`, `de`, `us`, `cn`).
- Never share or commit credentials (`userId`, `ssecurity`, `serviceToken`) to your repository.

## Verifying It Works

After restarting Homebridge, you should see log lines similar to these:

- `Xiaomi Hub 2 BLE platform started`
- `Registered sensor: Bedroom 1`
- `Bedroom 1: 23.4°C / 48.1%`

If the plugin starts correctly and the sensors appear in HomeKit with temperature and humidity values, the setup is working.

## Security Notes

- Never commit a real Homebridge `config.json` containing `userId`, `ssecurity`, or `serviceToken`.
- Never post terminal output that contains your Xiaomi Cloud credentials.
- Never commit downloaded token extraction files or temporary archives if they contain sensitive data.
- Rotate your Xiaomi credentials if you accidentally expose them publicly.

## Troubleshooting

- Check Homebridge logs:

```bash
sudo journalctl -u homebridge -f
```

- Common issues:
  - Wrong `country` selection
  - Invalid or expired `serviceToken`
  - Incorrect `did` value
  - Network latency or temporary Xiaomi Cloud issues
