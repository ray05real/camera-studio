# Camera Studio — project brief

Read this first in every session. A personal tool for the owner (not for the App Store): see the iPhone's camera
live on the Windows PC, control every camera setting from the PC, and record at the iPhone's full quality (4K) with
good sound, the video ending up on the PC. Camo Studio was the reference (it caps free use at 720p); nothing was
copied from it. No effects or beauty filters, just control. Free: no paid tools or subscriptions.

First use: filming a trailer for the owner's ToDo app (talking to camera at the desk, iPhone's BACK camera, so the
iPhone's screen faces away and the PC is the screen).

## Who you are working with
- The owner has **no coding experience**: explain each step in plain English, say exactly what to tap or click and
  what they should see. They type fast with typos: read for meaning.
- **Windows 11 PC** (Node 24 installed; in commands they type use `npm.cmd` / `npx.cmd`, PowerShell blocks .ps1)
  and an **iPhone 16 Pro on iOS 27.2**. No Mac.
- They sideload unsigned .ipa files by signing them on the phone in **Kravasigner** (paid certificate; ESign is a
  fallback). Avoid entitlements that need Apple's approval (e.g. multicast): sideload certificates may not grant them.
- Save to GitHub after every step that works, with a plain-English commit message. Ask them to test on the iPhone
  after each milestone. Keep costs at zero and say before anything would cost money.

## How it is built
- **iPhone app** (`ios/`): Swift / SwiftUI, iOS 18+. `ios/project.yml` (XcodeGen) makes the Xcode project on GitHub's
  Mac; `.github/workflows/build.yml` (copied from the owner's to-do app, `runs-on: xcode-27`) builds an **unsigned**
  .ipa on every push to main that touches `ios/` and publishes it as a GitHub Release. The repo is **public** (owner's OK,
  27 Oct 2026: Mac builds are free and the iPhone downloads without signing in; it can be made private later, then
  builds use the private-repo minutes and Safari must be signed in to GitHub). The iPhone downloads
  `https://github.com/ray05real/camera-studio/releases/latest/download/CameraStudio.ipa` and signs it in Kravasigner.
  - `Camera.swift`: one AVCaptureSession (preset inputPriority, wide colour off so we choose the colour space):
    camera input, mic input, **AVCaptureVideoDataOutput** (every full-quality frame) and AVCaptureAudioDataOutput.
    Lens: the triple camera ("All lenses", seamless 0.5×–25× zoom; display zoom = factor × displayVideoZoomFactorMultiplier)
    or one physical lens. Format picked by size / fps / HDR (HDR = 10-bit 'x420' + HLG_BT2020), fps 24/25/30/50/60/100/120
    by frame duration. Focus / exposure / white balance / torch with lockForConfiguration. Picture direction from
    AVCaptureDevice.RotationCoordinator; the shape (vertical / horizontal) is the PC's switch, and a mismatch with how
    the phone is held is reported (the PC shows a banner), not cropped.
  - `Recorder.swift`: **AVAssetWriter** (HEVC or H.264, Apple's recommended settings, rotation as metadata). Chosen over
    AVCaptureMovieFileOutput because the same frames also feed the PC preview and can have a look redrawn into them
    (whether MovieFileOutput + VideoDataOutput can run together could not be checked without a device; the writer
    route is what pro camera apps use). Looks (Core Image) are recorded only with SDR and ≤ 60 fps.
  - Preview to the PC: every frame up to 30/s is shrunk on the GPU (Lanczos) to 960 or 1280 px and sent as JPEG; a
    frame is dropped while the last is still going out, so a slow Wi-Fi never builds up delay.
  - Saved to Photos (add-only) and kept in the app's Documents/Recordings until the PC confirms it has the file
    (`received`), then deleted from the app. Files also show in the Files app (UIFileSharingEnabled).
  - Screen kept awake (the camera only runs in the foreground); goes black after 30 s once the PC is connected (tap wakes).
  - `Server.swift`: NWListener on TCP **47100**, Bonjour `_camstudio._tcp` (NSBonjourServices + local network usage
    string; no multicast entitlement needed). The phone shows its Wi-Fi address as a fallback.
- **PC app** (`pc/`): Node with **no npm packages** (nothing to install). `Camera Studio.cmd` (and the desktop shortcut
  made from it, icon `pc/ui/icon.ico`) starts `pc/server.js` minimised; it serves the page on **127.0.0.1:5810** only
  and opens it as an Edge app window (`msedge --app=`). Closing the window quits it ~20 s later (it waits for copies
  to finish). Starting it twice just reopens the window. Log and settings: `%APPDATA%\Camera Studio\`.
  - `lib/phone.js`: finds the iPhone in this order: **USB cable** (Apple Mobile Device Service's usbmux on
    127.0.0.1:27015, `lib/usbmux.js`; needs Apple Devices / iTunes installed, it is on the owner's PC), the last
    address, Bonjour (`lib/mdns.js`: legacy-unicast query from an ordinary port, so Windows' own port 5353 isn't
    needed), then trying every address on the PC's /24 networks. Moves to the cable when it's plugged in (not while
    recording or copying). Pings every 2 s (also measures the clock difference). Copies videos on separate
    connections, resuming after a break.
  - Page (`pc/ui/`): MJPEG preview in an `<img>`, live updates by Server-Sent Events, commands by POST (only accepted
    from this page: Host / Sec-Fetch-Site / X-Camera-Studio header checks). Click the picture = focus + exposure there.
  - **PC microphone**: recorded in the page (getUserMedia, AudioWorklet `pcm-worklet.js`, 48 kHz mono float) and sent to
    the server as it's recorded (`lib/wav.js`). It starts before "record" and stops 0.4 s after the video ends.
  - **Sound sync** (`lib/sync.js`): the iPhone always records its own sound too. The PC sound is lined up by
    cross-correlating it with the iPhone's (GCC-PHAT, 150–3800 Hz, 8 kHz), searching ±3 s around the clocks' guess;
    for takes over 90 s the drift between the two sound cards is measured at the end and corrected. ffmpeg then puts the
    PC sound (AAC 320k) on the iPhone picture (copied untouched, hvc1 tag and rotation kept). If the match is unclear
    it falls back to the clocks and says so.
  - Files: `%USERPROFILE%\Videos\Camera Studio\<name>.mov` is always the one to use; with the PC mic the iPhone-sound
    version and the PC .wav go to `Originals\`.
  - ffmpeg: found in `Documents\INSTALLERS\ffmpeg*\bin` (the owner's copy; its bin folder was empty on 27 Oct 2026,
    so ffmpeg.exe / ffprobe.exe were unpacked there from `Downloads\ffmpeg-8.0-essentials_build.7z`), else `tools\ffmpeg`, else PATH.

## Protocol (iPhone ↔ PC, TCP 47100)
Frame = 4-byte big-endian length (incl. type) + 1 type byte + payload. Types: 1 JSON, 2 preview JPEG, 3 file chunk.
PC → phone: `hello`, `ping`, `state`, `files`, `set {changes}` (partial CamSettings, see `Settings.swift`), `zoom
{value, smooth}`, `focusAt {x, y}` (0–1 on the turned preview), `record`, `stop`, `countdown {seconds}`,
`cancelCountdown`, `received {name}`, and on its own connection `download {name, offset}`.
Phone → PC: `hello`, `pong`, `state` (settings, caps, format, status, angle, mismatch, bitrate, recording, phone),
`live` (10/s: zoom, iso, shutter, lens, temp, tint, mic levels, rec, phone battery/heat/free space), `recStarted
{name, startWall}`, `recStopped {name, size, duration, codec, …}`, `recFailed`, `files {list}`, `photos {name, ok}`,
`message {text}`; downloads: `file {size, offset}`, chunks, `eof`.

## Testing without the iPhone
- `node pc/test/sync.test.js`: made-up recordings with a known offset and 40 ppm drift; checks the sync to < 2 ms and
  that the merged file keeps HEVC/hvc1 and rotation.
- `node pc/test/e2e.test.js` (after the sync test): the real PC server against `pc/test/fake-phone.js` (same protocol,
  test picture): connect, settings round trip, record with the PC mic, copy, line up, check.
- `node pc/test/demo.js` then open http://127.0.0.1:5811: the page driven by the fake iPhone.
- The iPhone code can only be compiled by the GitHub build: push and read the result (the failed build's log is
  published as the `build-log` release).

## The owner's choices and lessons (27 Oct 2026)
- No list of videos under the picture (it took too much room): a small **Videos** button in the top bar opens the
  folder, with one line next to it about the newest video (copying %, Saved ✓, Play).
- A **full-screen** button on the picture (or F): the picture and the record bar fill the screen.
- Preview sharpness: Smooth (960) / Sharp (1280) / Best (1920, needs good Wi-Fi or the cable). The owner first thought
  the video wasn't 4K: that was the small preview; the camera reported 3840×2160.
- **Never call `recommendedVideoSettings(forVideoCodecType:…)` without checking
  `availableVideoCodecTypesForAssetWriter(writingTo:)` first**: AVFoundation throws (the app closes) if the camera
  isn't ready, e.g. while starting or rearranging. Build 2 did this on every state update, so changing a setting or
  the screen going black closed the app; build 3 checks first and keeps the black screen on top of the camera view.
- Changing 4K → 1080p still closed the app on build 3 (cause unknown without the phone's crash log). Build 4 runs every
  risky AVFoundation call through `CSTry` (`ObjCCatch.m`, an Objective-C @try/@catch Swift can call, via the bridging
  header): the PC shows the reason instead of the app closing. An uncaught exception is saved and sent to the PC on
  the next connection (`crash` message; written to the PC log). The hello carries the app's build number (also on
  the phone's screen and in the PC's Connection card), so we always know which build the owner is running.
- The PC app must not have a window to close by mistake: `server.js` relaunches itself hidden (`--child`, detached,
  windowsHide) and the launcher's window closes at once. Closing the Camera Studio window is the only way to quit.
- Quality: Standard (Apple's data rate, ~18 Mbit/s at 4K24, like the Camera app) or High (2.5×). Sound is AAC
  192 kbit/s mono (Apple's default was ~100). The owner's first test file was genuine 3840×2160 HEVC.
- The owner's Wi-Fi is a big network (PC 10.156.205.70/20, iPhone 10.156.203.203): the address search covers the
  network's real size up to a /20, nearest addresses first; a typed address connects at once.

## Status
- 27 Oct 2026: first version. iPhone build 1 compiled first time; PC side tested against the fake iPhone (sync and
  end-to-end tests pass). **Not yet tried on the real iPhone**: the owner's first test is the next step.
- Things only the real phone can confirm: the formats offered on the 16 Pro (4K120, HDR at 50/60), that recording
  4K60 with a look keeps up, USB through Apple's service (needs "Trust this computer"), the local network prompt,
  the phone's mic choices, and the preview delay over Wi-Fi.
