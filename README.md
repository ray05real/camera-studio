# Camera Studio

See your iPhone's camera live on your Windows PC, change every camera setting from the PC, and record on the iPhone
at full quality (4K, HEVC, optional HDR) with the sound from the iPhone or from a microphone plugged into the PC.
Each video is saved to the iPhone's Photos and copied to `Videos\Camera Studio` on the PC.

## Setting up
1. **iPhone**: in Safari open
   https://github.com/ray05real/camera-studio/releases/latest/download/CameraStudio.ipa, then sign and install it in
   Kravasigner. Open Camera Studio and allow the camera, microphone, local network and Photos.
2. **PC**: double-click **Camera Studio** on the desktop (or `Camera Studio.cmd` in this folder). Needs Node.js. For the
   PC microphone's sound to be added to videos it uses ffmpeg (it looks in `Documents\INSTALLERS`).
3. The PC finds the iPhone on the same Wi-Fi (or by USB cable if Apple Devices is installed). If not, type the
   address the iPhone shows.

## What's inside
- `ios/`: the iPhone app (Swift), built into an unsigned .ipa by GitHub Actions on every change.
- `pc/`: the PC app (Node, no packages to install) and its page (`pc/ui`).
- `pc/test/`: tests and a fake iPhone for trying the PC side without the phone.
