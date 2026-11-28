# Alice for iOS

A native SwiftUI client for a running Alice server. It uses the same `/api` endpoints as the web board and follows the web UI: Today, board lanes, card tiles, card detail (Overview, Review, Attempts, Discuss, Details), chat, settings.

## Run it

The project is generated with [XcodeGen](https://github.com/yonaskolb/XcodeGen) from `project.yml`.

```sh
cd ios
xcodegen generate
open Alice.xcodeproj
```

On first launch enter the server address, for example `mochi:4317`. The server only accepts Host names listed in `ALICE_ALLOWED_HOSTS`, so add that name there.

`scripts/sim.sh` builds on a remote Mac over ssh and launches the simulator (`MAC_HOST`, default `visitingstar`). Launch arguments such as `-serverURL`, `-startRoute today|settings|board:<id>` and `-startCard <id>` open a screen directly.

## Layout

- `Alice/Networking` API client.
- `Alice/Models` Codable types mirroring `src/model.ts`.
- `Alice/Theme` colours from `src/style.css`, light and dark.
- `Alice/Views` screens.

## Tests

`AliceTests` are unit tests with no server, for example decoding. Run them on the Mac with `xcodegen generate`, then `xcodebuild -project Alice.xcodeproj -scheme Alice -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 16' CODE_SIGNING_ALLOWED=NO -only-testing:AliceTests test`.

## UI tests

`ALICE_BOARD=<scratch board id> scripts/sim.sh test` runs `AliceUITests` on the simulator against a live server and copies screenshots to `/tmp/alice-ios-shots`. Use a scratch board: the tests create and move cards.

## TestFlight

`ASC_KEY_ID=... ASC_ISSUER_ID=... scripts/testflight.sh` archives on the Mac and uploads to TestFlight. The key must have the Admin role (App Manager cannot create cloud-managed distribution certificates) and live at `~/.appstoreconnect/private_keys/AuthKey_<id>.p8` on the Mac.
