# homebridge-xiaomi-hub2-ble

Homebridge plugin for Xiaomi Smart Home Hub 2 BLE temperature and humidity sensors via Xiaomi Cloud.

## State

Tested on Raspberry Pi + Homebridge and confirmed working.

## Requirements

- Node.js 18+
- Homebridge 1.6.0+
- Python 3.9+ (for Xiaomi token extraction)
- `git` (to clone the token extractor repository)
- Xiaomi Cloud credentials:
  - userId
  - ssecurity
  - serviceToken
- Sensor DID values

## Installation

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
python3 -m pip install -r requirements.txt
python3 token_extractor.py
```

In the script, print the values right below the following block:

```python
if logged:
    print_if_interactive(f"{Fore.GREEN}Logged in.")
    print("USER_ID:", connector.userId)
    print("SSECURITY:", connector._ssecurity)
    print("SERVICE_TOKEN:", connector._serviceToken)
```

Use these values in your Homebridge config.

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

## Notes

- `pollInterval` minimum is 60 seconds. Recommended value is 120 seconds or higher.
- `country` may vary based on your Xiaomi account region (for example: `tw`, `de`, `us`, `cn`).
- Never share or commit credentials (`userId`, `ssecurity`, `serviceToken`) to your repository.

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
