import AVFoundation
import CoreImage
import UIKit

protocol CameraDelegate: AnyObject {
    func cameraStateChanged()
    func cameraPreviewFrame(_ jpeg: Data)
    func cameraRecordingStarted(name: String, startWall: Double)
    func cameraRecordingFinished(_ info: [String: Any], url: URL)
    func cameraRecordingFailed(_ message: String)
    func cameraMessage(_ text: String)
}

/// The camera: one capture session with the camera, the microphone, a video data output (every frame, at full
/// quality, for the recorder and the PC preview) and an audio data output. Settings change on `sessionQueue`;
/// frames arrive on `dataQueue`; preview pictures are made on `previewQueue`.
final class Camera: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, AVCaptureAudioDataOutputSampleBufferDelegate {
    static let frameRates: [Double] = [24, 25, 30, 50, 60, 100, 120]

    let session = AVCaptureSession()
    weak var delegate: CameraDelegate?

    private let sessionQueue = DispatchQueue(label: "studio.session")
    private let dataQueue = DispatchQueue(label: "studio.data", qos: .userInteractive)
    private let previewQueue = DispatchQueue(label: "studio.preview", qos: .userInitiated)
    private let videoOutput = AVCaptureVideoDataOutput()
    private let audioOutput = AVCaptureAudioDataOutput()
    private let ci = CIContext(options: [.cacheIntermediates: false])
    private let srgb = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
    private lazy var recorder: Recorder = {
        let r = Recorder(ci: ci, queue: dataQueue)
        r.onStarted = { [weak self] pts in self?.recordingDidStart(pts) }
        r.onFailed = { [weak self] message in self?.recordingDidFail(message) }
        return r
    }()

    // sessionQueue only
    private(set) var settings = CamSettings.load()
    private var videoInput: AVCaptureDeviceInput?
    private var hasMic = false
    private var caps: [String: Any] = [:]
    private var formatLabel = ""
    private var bitrate = 0.0
    private var rotationCoordinator: AVCaptureDevice.RotationCoordinator?
    private var rotationObservation: NSKeyValueObservation?
    private var status = "Starting the camera…"
    private var started = false

    // read from any queue
    private let currentDevice = Locked<AVCaptureDevice?>(nil)
    private let physicalAngle = Locked<Double>(90)
    private let shared = Locked(Shared())
    private let previewBusy = Locked(false)
    private let audioLevel = Locked<(avg: Float, peak: Float)>((-160, -160))
    private let rec = Locked(RecState())

    struct Shared {
        var look = "none"
        var looksOnRecording = true
        var previewWanted = false
        var previewSize = 960
        var previewQuality = 0.6
        var angle = 0                 // how the picture is turned (0 / 90 / 180 / 270, clockwise)
        var mismatch = false          // the phone is held the other way from the chosen shape
        var physical = "unknown"      // how the phone is actually held: upright / sideways
    }

    struct RecState {
        var active = false            // from "record" until the file is finished
        var name = ""
        var startWall = 0.0
        var startedAt: Date?
        var bitrate = 0.0
        var info: [String: Any] = [:]
    }

    // dataQueue only
    private var lastPreviewPTS = CMTime.invalid
    private var previewPool: CVPixelBufferPool?
    private var previewPoolSize = CGSize.zero

    var device: AVCaptureDevice? { currentDevice.get }
    var isRecording: Bool { rec.get.active }
    var recordingName: String? { rec.get.active ? rec.get.name : nil }

    static var recordingsFolder: URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let folder = docs.appendingPathComponent("Recordings", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    // MARK: - Starting

    func start(withMic micAllowed: Bool) {
        sessionQueue.async {
            guard !self.started else { return }
            self.started = true
            self.observeSession()
            self.session.beginConfiguration()
            if self.session.canSetSessionPreset(.inputPriority) { self.session.sessionPreset = .inputPriority }
            self.session.automaticallyConfiguresCaptureDeviceForWideColor = false
            if micAllowed, let mic = AVCaptureDevice.default(for: .audio),
               let input = try? AVCaptureDeviceInput(device: mic), self.session.canAddInput(input) {
                self.session.addInput(input)
                self.hasMic = true
            }
            self.videoOutput.alwaysDiscardsLateVideoFrames = false
            self.videoOutput.setSampleBufferDelegate(self, queue: self.dataQueue)
            if self.session.canAddOutput(self.videoOutput) { self.session.addOutput(self.videoOutput) }
            self.audioOutput.setSampleBufferDelegate(self, queue: self.dataQueue)
            if self.hasMic, self.session.canAddOutput(self.audioOutput) { self.session.addOutput(self.audioOutput) }
            self.session.commitConfiguration()
            self.reconfigure()
            self.session.startRunning()
            self.applyControls(force: true)
            self.applyMic()
            self.bitrate = Camera.averageBitrate(self.recommendedVideoSettings(codec: self.currentCodec))
            self.status = self.session.isRunning ? "running" : "The camera didn't start."
            self.updateShared()
            self.delegate?.cameraStateChanged()
        }
    }

    private func observeSession() {
        let nc = NotificationCenter.default
        nc.addObserver(forName: AVCaptureSession.wasInterruptedNotification, object: session, queue: nil) { [weak self] note in
            guard let self else { return }
            let reason = (note.userInfo?[AVCaptureSessionInterruptionReasonKey] as? NSNumber)
                .flatMap { AVCaptureSession.InterruptionReason(rawValue: $0.intValue) }
            if self.isRecording { self.stopRecording() }
            self.sessionQueue.async {
                switch reason {
                case .videoDeviceNotAvailableInBackground: self.status = "Paused: open Camera Studio on the iPhone."
                case .audioDeviceInUseByAnotherClient, .videoDeviceInUseByAnotherClient:
                    self.status = "Paused: another app is using the camera or microphone."
                case .videoDeviceNotAvailableDueToSystemPressure: self.status = "Paused: the iPhone is too hot."
                default: self.status = "Paused by the iPhone (a call or another app)."
                }
                self.delegate?.cameraStateChanged()
            }
        }
        nc.addObserver(forName: AVCaptureSession.interruptionEndedNotification, object: session, queue: nil) { [weak self] _ in
            self?.sessionQueue.async {
                self?.status = "running"
                self?.delegate?.cameraStateChanged()
            }
        }
        nc.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: nil) { [weak self] note in
            guard let self else { return }
            let error = note.userInfo?[AVCaptureSessionErrorKey] as? Error
            if self.isRecording { self.stopRecording() }
            self.sessionQueue.async {
                self.status = "Camera error: \(error?.localizedDescription ?? "unknown"). Restarting…"
                self.delegate?.cameraStateChanged()
                self.session.startRunning()
                if self.session.isRunning { self.status = "running" }
                self.delegate?.cameraStateChanged()
            }
        }
    }

    /// Restarts the camera after the app comes back to the screen.
    func resume() {
        sessionQueue.async {
            guard self.started, !self.session.isRunning else { return }
            self.session.startRunning()
            if self.session.isRunning { self.status = "running" }
            self.delegate?.cameraStateChanged()
        }
    }

    // MARK: - Choosing the camera and its format

    private func findDevice(_ s: CamSettings) -> AVCaptureDevice? {
        if s.position == "front" {
            return AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front)
                ?? AVCaptureDevice.default(.builtInTrueDepthCamera, for: .video, position: .front)
        }
        let types: [AVCaptureDevice.DeviceType]
        switch s.lens {
        case "ultrawide": types = [.builtInUltraWideCamera]
        case "wide": types = [.builtInWideAngleCamera]
        case "tele": types = [.builtInTelephotoCamera]
        default: types = [.builtInTripleCamera, .builtInDualWideCamera, .builtInDualCamera, .builtInWideAngleCamera]
        }
        for type in types {
            if let d = AVCaptureDevice.default(type, for: .video, position: .back) { return d }
        }
        return AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)
    }

    private func availableLenses(_ position: String) -> [String] {
        if position == "front" { return ["wide"] }
        var list = ["auto"]
        if AVCaptureDevice.default(.builtInUltraWideCamera, for: .video, position: .back) != nil { list.append("ultrawide") }
        if AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) != nil { list.append("wide") }
        if AVCaptureDevice.default(.builtInTelephotoCamera, for: .video, position: .back) != nil { list.append("tele") }
        return list
    }

    private static func stabilizationMode(_ name: String) -> AVCaptureVideoStabilizationMode {
        switch name {
        case "standard": return .standard
        case "cinematic": return .cinematic
        case "extended": return .cinematicExtended
        default: return .off
        }
    }

    private func bestFormat(_ d: AVCaptureDevice, _ res: String, _ fps: Double, _ hdr: Bool) -> AVCaptureDevice.Format? {
        let (w, h): (Int32, Int32) = res == "4k" ? (3840, 2160) : (1920, 1080)
        let wantedStab = Camera.stabilizationMode(settings.stabilization)
        let list = d.formats.filter { f in
            let dims = CMVideoFormatDescriptionGetDimensions(f.formatDescription)
            guard dims.width == w, dims.height == h else { return false }
            guard f.videoSupportedFrameRateRanges.contains(where: { $0.minFrameRate <= fps + 0.01 && fps <= $0.maxFrameRate + 0.01 })
            else { return false }
            let sub = CMFormatDescriptionGetMediaSubType(f.formatDescription)
            if hdr {
                return sub == kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange && f.supportedColorSpaces.contains(.HLG_BT2020)
            }
            return sub == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange || sub == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
        }
        func score(_ f: AVCaptureDevice.Format) -> Double {
            var s = 0.0
            let sub = CMFormatDescriptionGetMediaSubType(f.formatDescription)
            if sub != kCVPixelFormatType_420YpCbCr8BiPlanarFullRange { s += 4 }
            if wantedStab != .off, f.isVideoStabilizationModeSupported(wantedStab) { s += 3 }
            if f.isVideoStabilizationModeSupported(.cinematicExtended) { s += 1 }
            let maxRate = f.videoSupportedFrameRateRanges.map(\.maxFrameRate).max() ?? 0
            s -= maxRate / 1000
            s += Double(f.videoFieldOfView) / 1000
            return s
        }
        return list.max(by: { score($0) < score($1) })
    }

    /// The format for the wanted settings, or the nearest that works (and a note saying what changed).
    private func chooseFormat(_ d: AVCaptureDevice) -> (format: AVCaptureDevice.Format?, fps: Double, hdr: Bool, note: String?) {
        let res = settings.resolution
        let fps = settings.fps
        let hdr = settings.hdr
        if let f = bestFormat(d, res, fps, hdr) { return (f, fps, hdr, nil) }
        if hdr, let f = bestFormat(d, res, fps, false) {
            return (f, fps, false, "HDR isn't available at \(Int(fps)) fps on this camera, so HDR is off.")
        }
        for alt in Camera.frameRates.sorted(by: { abs($0 - fps) < abs($1 - fps) }) {
            if let f = bestFormat(d, res, alt, hdr) {
                return (f, alt, hdr, "\(Int(fps)) fps isn't available here, so it's set to \(Int(alt)) fps.")
            }
        }
        for alt in Camera.frameRates.sorted(by: { abs($0 - fps) < abs($1 - fps) }) {
            if let f = bestFormat(d, res, alt, false) {
                return (f, alt, false, "Set to \(Int(alt)) fps without HDR (the nearest this camera can do).")
            }
        }
        return (nil, fps, hdr, "This camera can't film in \(res == "4k" ? "4K" : "1080p").")
    }

    /// Applies the camera, lens, resolution, frame rate, HDR and stabilisation. Session queue.
    private func reconfigure() {
        session.beginConfiguration()
        let wanted = findDevice(settings)
        if let wanted, wanted.uniqueID != videoInput?.device.uniqueID {
            let old = videoInput
            if let old { session.removeInput(old) }
            if let input = try? AVCaptureDeviceInput(device: wanted), session.canAddInput(input) {
                session.addInput(input)
                videoInput = input
                currentDevice.set(wanted)
                makeRotationCoordinator(wanted)
            } else if let old, session.canAddInput(old) {
                session.addInput(old)
                delegate?.cameraMessage("That camera couldn't be opened.")
            }
        }
        guard let d = videoInput?.device else {
            session.commitConfiguration()
            status = "No camera found."
            return
        }
        settings.position = d.position == .front ? "front" : "back"
        let choice = chooseFormat(d)
        settings.fps = choice.fps
        settings.hdr = choice.hdr
        if let note = choice.note { delegate?.cameraMessage(note) }
        do {
            try d.lockForConfiguration()
            if let f = choice.format { d.activeFormat = f }
            let duration = CMTime(value: 1, timescale: CMTimeScale(choice.fps.rounded()))
            d.activeVideoMinFrameDuration = duration
            d.activeVideoMaxFrameDuration = duration
            let spaces = d.activeFormat.supportedColorSpaces
            if choice.hdr, spaces.contains(.HLG_BT2020) {
                d.activeColorSpace = .HLG_BT2020
            } else if spaces.contains(.sRGB) {
                d.activeColorSpace = .sRGB
            }
            d.unlockForConfiguration()
        } catch {
            delegate?.cameraMessage("The camera couldn't be set up: \(error.localizedDescription)")
        }
        let pixelFormat = choice.hdr ? kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange : kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        videoOutput.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: pixelFormat]
        if let c = videoOutput.connection(with: .video), c.isVideoStabilizationSupported {
            let mode = Camera.stabilizationMode(settings.stabilization)
            c.preferredVideoStabilizationMode = d.activeFormat.isVideoStabilizationModeSupported(mode) ? mode : .off
            if mode != .off, !d.activeFormat.isVideoStabilizationModeSupported(mode) {
                settings.stabilization = "off"
                delegate?.cameraMessage("That stabilisation isn't available in this format.")
            }
        }
        session.commitConfiguration()
        let dims = CMVideoFormatDescriptionGetDimensions(d.activeFormat.formatDescription)
        formatLabel = "\(dims.width)×\(dims.height) · \(Int(settings.fps)) fps · \(settings.hdr ? "HDR (HLG, 10-bit)" : "SDR")"
        computeCaps(d)
        bitrate = Camera.averageBitrate(recommendedVideoSettings(codec: currentCodec))
    }

    private var currentCodec: AVVideoCodecType { (settings.codec == "h264" && !settings.hdr) ? .h264 : .hevc }

    /// Apple's settings for recording this format, or nil while the camera isn't ready. AVFoundation throws an
    /// exception (which closes the app) if asked for a codec it doesn't list right now, so check first. Session queue.
    private func recommendedVideoSettings(codec: AVVideoCodecType) -> [String: Any]? {
        guard videoOutput.connection(with: .video) != nil,
              videoOutput.availableVideoCodecTypesForAssetWriter(writingTo: .mov).contains(codec) else { return nil }
        return videoOutput.recommendedVideoSettings(forVideoCodecType: codec, assetWriterOutputFileType: .mov) as? [String: Any]
    }

    private static func averageBitrate(_ video: [String: Any]?) -> Double {
        ((video?[AVVideoCompressionPropertiesKey] as? [String: Any])?[AVVideoAverageBitRateKey] as? NSNumber)?.doubleValue ?? 0
    }

    private func computeCaps(_ d: AVCaptureDevice) {
        var c: [String: Any] = [:]
        var positions: [String] = []
        if AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) != nil { positions.append("back") }
        if AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front) != nil { positions.append("front") }
        c["positions"] = positions
        c["lenses"] = availableLenses(settings.position)
        let mult = Double(d.displayVideoZoomFactorMultiplier)
        let minZoom = Double(d.minAvailableVideoZoomFactor) * mult
        let maxZoom = min(Double(d.maxAvailableVideoZoomFactor) * mult, 25)
        let presets = [0.5, 1, 2, 3, 5].filter { $0 >= minZoom - 0.01 && $0 <= maxZoom + 0.01 }
        let switches = d.virtualDeviceSwitchOverVideoZoomFactors.map { $0.doubleValue * mult }
        c["zoom"] = ["min": finite(minZoom), "max": finite(maxZoom), "presets": presets, "switches": switches.map { finite($0) }]
        var fps: [String: [Double]] = [:]
        var fpsHDR: [String: [Double]] = [:]
        for res in ["4k", "1080p"] {
            fps[res] = Camera.frameRates.filter { bestFormat(d, res, $0, false) != nil }
            fpsHDR[res] = Camera.frameRates.filter { bestFormat(d, res, $0, true) != nil }
        }
        c["fps"] = fps
        c["fpsHDR"] = fpsHDR
        let f = d.activeFormat
        c["iso"] = ["min": finite(f.minISO), "max": finite(f.maxISO)]
        c["shutter"] = ["min": finite(f.minExposureDuration.seconds),
                        "max": finite(min(f.maxExposureDuration.seconds, 1 / settings.fps))]
        c["bias"] = ["min": finite(max(d.minExposureTargetBias, -4)), "max": finite(min(d.maxExposureTargetBias, 4))]
        c["focusManual"] = d.isLockingFocusWithCustomLensPositionSupported
        c["focusPoint"] = d.isFocusPointOfInterestSupported
        c["exposureManual"] = d.isExposureModeSupported(.custom)
        c["exposurePoint"] = d.isExposurePointOfInterestSupported
        c["wbManual"] = d.isLockingWhiteBalanceWithCustomDeviceGainsSupported
        c["torch"] = d.hasTorch
        c["stabilization"] = ["off", "standard", "cinematic", "extended"].filter {
            $0 == "off" || f.isVideoStabilizationModeSupported(Camera.stabilizationMode($0))
        }
        c["looks"] = Looks.all.map { ["id": $0.id, "name": $0.name] }
        c["mics"] = micList()
        c["hasMic"] = hasMic
        caps = c
    }

    // MARK: - Turning the picture

    private func makeRotationCoordinator(_ d: AVCaptureDevice) {
        rotationObservation?.invalidate()
        let rc = AVCaptureDevice.RotationCoordinator(device: d, previewLayer: nil)
        rotationCoordinator = rc
        rotationObservation = rc.observe(\.videoRotationAngleForHorizonLevelCapture, options: [.initial, .new]) { [weak self] rc, _ in
            guard let self else { return }
            self.physicalAngle.set(Double(rc.videoRotationAngleForHorizonLevelCapture))
            self.sessionQueue.async {
                self.updateShared()
                self.delegate?.cameraStateChanged()
            }
        }
    }

    /// The shape (vertical / horizontal) comes from the switch on the PC; which way up comes from how the phone is held.
    private func updateShared() {
        let a = (Int(physicalAngle.get.rounded()) % 360 + 360) % 360
        let upright = a == 90 || a == 270
        let s = settings
        shared.mutate { sh in
            if s.orientation == "vertical" {
                sh.angle = upright ? a : 90
                sh.mismatch = !upright
            } else {
                sh.angle = upright ? 0 : a
                sh.mismatch = upright
            }
            sh.physical = upright ? "upright" : "sideways"
            sh.look = s.look
            sh.looksOnRecording = !s.hdr && s.fps <= 60
            sh.previewSize = max(320, min(1920, s.previewSize))
            sh.previewQuality = max(0.2, min(0.95, s.previewQuality))
        }
    }

    func setPreviewWanted(_ wanted: Bool) {
        shared.mutate { $0.previewWanted = wanted }
    }

    static func orientation(for angle: Int) -> CGImagePropertyOrientation {
        switch angle {
        case 90: return .right
        case 180: return .down
        case 270: return .left
        default: return .up
        }
    }

    /// A point on the (turned) PC preview, 0…1, to the camera's own coordinates for focus and exposure.
    static func devicePoint(_ p: CGPoint, angle: Int) -> CGPoint {
        let x = min(max(p.x, 0), 1), y = min(max(p.y, 0), 1)
        switch angle {
        case 90: return CGPoint(x: y, y: 1 - x)
        case 180: return CGPoint(x: 1 - x, y: 1 - y)
        case 270: return CGPoint(x: 1 - y, y: x)
        default: return CGPoint(x: x, y: y)
        }
    }

    // MARK: - Changing settings from the PC

    func update(_ changes: [String: Any]) {
        sessionQueue.async {
            let old = self.settings
            var new = old.merged(changes)
            if self.isRecording {
                let locked = old.position != new.position || old.lens != new.lens || old.resolution != new.resolution
                    || old.fps != new.fps || old.hdr != new.hdr || old.codec != new.codec
                    || old.orientation != new.orientation || old.stabilization != new.stabilization || old.look != new.look
                if locked {
                    new.position = old.position; new.lens = old.lens; new.resolution = old.resolution
                    new.fps = old.fps; new.hdr = old.hdr; new.codec = old.codec
                    new.orientation = old.orientation; new.stabilization = old.stabilization; new.look = old.look
                    self.delegate?.cameraMessage("Stop recording first to change the camera, format or look.")
                }
            }
            if new.position != old.position { new.lens = new.position == "front" ? "wide" : "auto" }
            if new.hdr { new.codec = "hevc" }
            self.settings = new
            let structural = old.position != new.position || old.lens != new.lens || old.resolution != new.resolution
                || old.fps != new.fps || old.hdr != new.hdr || old.stabilization != new.stabilization
            if structural {
                self.reconfigure()
                self.applyControls(force: true)
                self.applyMic()
            } else {
                self.applyControls(force: false, old: old)
                if old.micInput != new.micInput || old.micSource != new.micSource { self.applyMic() }
                if old.exposure.mode != new.exposure.mode, let d = self.device { self.computeCaps(d) }
                if old.codec != new.codec { self.bitrate = Camera.averageBitrate(self.recommendedVideoSettings(codec: self.currentCodec)) }
            }
            self.updateShared()
            self.settings.save()
            self.delegate?.cameraStateChanged()
        }
    }

    func zoom(to value: Double, smooth: Bool) {
        sessionQueue.async {
            guard let d = self.device else { return }
            let mult = Double(d.displayVideoZoomFactorMultiplier)
            let factor = min(max(value / mult, Double(d.minAvailableVideoZoomFactor)), Double(d.maxAvailableVideoZoomFactor), 25 / mult)
            do {
                try d.lockForConfiguration()
                if smooth {
                    d.ramp(toVideoZoomFactor: CGFloat(factor), withRate: 6)
                } else {
                    d.cancelVideoZoomRamp()
                    d.videoZoomFactor = CGFloat(factor)
                }
                d.unlockForConfiguration()
            } catch {}
            self.settings.zoom = factor * mult
            self.settings.save()
            self.delegate?.cameraStateChanged()
        }
    }

    /// Click on the PC preview: focus and expose there (like tapping the iPhone's screen).
    func focus(atDisplay p: CGPoint) {
        sessionQueue.async {
            guard let d = self.device else { return }
            let point = Camera.devicePoint(p, angle: self.shared.get.angle)
            do {
                try d.lockForConfiguration()
                if d.isFocusPointOfInterestSupported { d.focusPointOfInterest = point }
                if d.isFocusModeSupported(.continuousAutoFocus) {
                    d.focusMode = .continuousAutoFocus
                } else if d.isFocusModeSupported(.autoFocus) {
                    d.focusMode = .autoFocus
                }
                if self.settings.exposure.mode != "manual" {
                    if d.isExposurePointOfInterestSupported { d.exposurePointOfInterest = point }
                    if d.isExposureModeSupported(.continuousAutoExposure) { d.exposureMode = .continuousAutoExposure }
                }
                d.unlockForConfiguration()
            } catch {}
            self.settings.focus.mode = "auto"
            if self.settings.exposure.mode == "locked" { self.settings.exposure.mode = "auto" }
            self.settings.save()
            self.delegate?.cameraStateChanged()
        }
    }

    /// Focus, exposure, white balance, zoom and torch. Session queue.
    private func applyControls(force: Bool, old: CamSettings? = nil) {
        guard let d = device else { return }
        let s = settings
        do { try d.lockForConfiguration() } catch { return }
        defer { d.unlockForConfiguration() }

        if force || old?.zoom != s.zoom {
            let mult = Double(d.displayVideoZoomFactorMultiplier)
            let factor = min(max(s.zoom / mult, Double(d.minAvailableVideoZoomFactor)), Double(d.maxAvailableVideoZoomFactor), 25 / mult)
            d.videoZoomFactor = CGFloat(factor)
            settings.zoom = factor * mult
        }

        if force || old?.focus != s.focus {
            if s.focus.mode == "manual", d.isLockingFocusWithCustomLensPositionSupported {
                d.setFocusModeLocked(lensPosition: min(max(s.focus.lens, 0), 1), completionHandler: nil)
            } else if s.focus.mode == "locked", d.isFocusModeSupported(.locked) {
                d.focusMode = .locked
            } else if d.isFocusModeSupported(.continuousAutoFocus) {
                if old?.focus.mode != "auto", d.isFocusPointOfInterestSupported { d.focusPointOfInterest = CGPoint(x: 0.5, y: 0.5) }
                d.focusMode = .continuousAutoFocus
            }
        }

        if force || old?.exposure != s.exposure || old?.fps != s.fps {
            let f = d.activeFormat
            if s.exposure.mode == "manual", d.isExposureModeSupported(.custom) {
                let longest = min(f.maxExposureDuration.seconds, 1.0 / s.fps)
                let shutter = min(max(s.exposure.shutter, f.minExposureDuration.seconds), longest)
                let iso = min(max(s.exposure.iso, f.minISO), f.maxISO)
                d.setExposureModeCustom(duration: CMTime(seconds: shutter, preferredTimescale: 1_000_000_000), iso: iso, completionHandler: nil)
            } else if s.exposure.mode == "locked", d.isExposureModeSupported(.locked) {
                d.exposureMode = .locked
            } else {
                if d.isExposureModeSupported(.continuousAutoExposure) {
                    if old?.exposure.mode != "auto", d.isExposurePointOfInterestSupported { d.exposurePointOfInterest = CGPoint(x: 0.5, y: 0.5) }
                    d.exposureMode = .continuousAutoExposure
                }
                let bias = min(max(s.exposure.bias, d.minExposureTargetBias), d.maxExposureTargetBias)
                d.setExposureTargetBias(bias, completionHandler: nil)
            }
        }

        if force || old?.wb != s.wb {
            if s.wb.mode == "manual", d.isLockingWhiteBalanceWithCustomDeviceGainsSupported {
                let values = AVCaptureDevice.WhiteBalanceTemperatureAndTintValues(temperature: s.wb.temp, tint: s.wb.tint)
                var g = d.deviceWhiteBalanceGains(for: values)
                let top = d.maxWhiteBalanceGain
                g.redGain = min(max(g.redGain, 1), top)
                g.greenGain = min(max(g.greenGain, 1), top)
                g.blueGain = min(max(g.blueGain, 1), top)
                d.setWhiteBalanceModeLocked(with: g, completionHandler: nil)
            } else if s.wb.mode == "locked", d.isWhiteBalanceModeSupported(.locked) {
                d.whiteBalanceMode = .locked
            } else if d.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) {
                d.whiteBalanceMode = .continuousAutoWhiteBalance
            }
        }

        if force || old?.torch != s.torch {
            if d.hasTorch {
                if s.torch > 0.001, d.isTorchAvailable {
                    try? d.setTorchModeOn(level: min(max(s.torch, 0.02), AVCaptureDevice.maxAvailableTorchLevel))
                } else if d.isTorchModeSupported(.off) {
                    d.torchMode = .off
                }
            }
        }
    }

    // MARK: - Microphone

    private func micList() -> [[String: Any]] {
        let inputs = AVAudioSession.sharedInstance().availableInputs ?? []
        return inputs.map { port in
            [
                "id": port.uid,
                "name": port.portName,
                "builtIn": port.portType == .builtInMic,
                "sources": (port.dataSources ?? []).map { ["id": $0.dataSourceID.stringValue, "name": $0.dataSourceName] },
            ]
        }
    }

    /// Picks the input (built-in or one plugged into the iPhone) and which built-in mic. Session queue.
    private func applyMic() {
        let audio = AVAudioSession.sharedInstance()
        let inputs = audio.availableInputs ?? []
        let chosen = inputs.first(where: { $0.uid == settings.micInput })
        if settings.micInput.isEmpty || chosen == nil {
            try? audio.setPreferredInput(nil)
        } else if let chosen {
            try? audio.setPreferredInput(chosen)
        }
        let port = chosen ?? inputs.first(where: { $0.portType == .builtInMic })
        if let port, let sources = port.dataSources, !sources.isEmpty {
            if let source = sources.first(where: { $0.dataSourceID.stringValue == settings.micSource }) {
                if let patterns = source.supportedPolarPatterns, patterns.contains(.cardioid) {
                    try? source.setPreferredPolarPattern(.cardioid)
                }
                try? port.setPreferredDataSource(source)
            } else {
                try? port.setPreferredDataSource(nil)
            }
        }
        if let d = device { computeCaps(d) }
    }

    // MARK: - State for the PC

    /// Everything the PC shows (settings and what this camera can do). Calls back on the session queue.
    func state(_ done: @escaping ([String: Any]) -> Void) {
        sessionQueue.async {
            let sh = self.shared.get
            let r = self.rec.get
            var state: [String: Any] = [
                "settings": self.settings.dictionary(),
                "caps": self.caps,
                "format": self.formatLabel,
                "status": self.status,
                "angle": sh.angle,
                "mismatch": sh.mismatch,
                "physical": sh.physical,
                "looksOnRecording": sh.looksOnRecording,
            ]
            state["bitrate"] = finite(self.bitrate)
            state["recording"] = ["active": r.active, "name": r.name, "startWall": finite(r.startWall),
                                  "elapsed": finite(r.startedAt.map { Date().timeIntervalSince($0) } ?? 0),
                                  "bitrate": finite(r.bitrate)]
            done(state)
        }
    }

    /// Values that change all the time (what auto exposure is doing, sound levels), read without waiting.
    func live() -> [String: Any] {
        var l: [String: Any] = [:]
        if let d = device {
            l["zoom"] = finite(Double(d.videoZoomFactor) * Double(d.displayVideoZoomFactorMultiplier))
            l["iso"] = finite(d.iso)
            l["shutter"] = finite(d.exposureDuration.seconds)
            l["lens"] = finite(d.lensPosition)
            l["offset"] = finite(d.exposureTargetOffset)
            let tt = d.temperatureAndTintValues(for: d.deviceWhiteBalanceGains)
            l["temp"] = finite(tt.temperature)
            l["tint"] = finite(tt.tint)
            l["focusing"] = d.isAdjustingFocus
            let level = d.systemPressureState.level
            l["pressure"] = level == .nominal ? "ok" : level == .fair ? "warm" : level == .serious ? "hot" : "critical"
        }
        let a = audioLevel.get
        l["mic"] = ["avg": finite(a.avg), "peak": finite(a.peak)]
        let r = rec.get
        l["rec"] = ["active": r.active, "elapsed": finite(r.startedAt.map { Date().timeIntervalSince($0) } ?? 0)]
        return l
    }

    // MARK: - Recording

    private static func newFileName() -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_GB_POSIX")
        f.dateFormat = "yyyy-MM-dd 'at' HH.mm.ss"
        return "Camera Studio \(f.string(from: Date())).mov"
    }

    func startRecording() {
        sessionQueue.async {
            guard !self.isRecording else {
                self.delegate?.cameraMessage("Still saving the last video. Try again in a moment.")
                return
            }
            guard let d = self.device, self.session.isRunning else {
                self.delegate?.cameraRecordingFailed("The camera isn't running.")
                return
            }
            let s = self.settings
            let sh = self.shared.get
            let codec = self.currentCodec
            guard let video = self.recommendedVideoSettings(codec: codec) else {
                self.delegate?.cameraRecordingFailed("The camera isn't ready to record yet. Try again in a moment.")
                return
            }
            let audio = self.hasMic ? (self.audioOutput.recommendedAudioSettingsForAssetWriter(writingTo: .mov) as? [String: Any]) : nil
            let dims = CMVideoFormatDescriptionGetDimensions(d.activeFormat.formatDescription)
            let useLook = sh.look != "none" && sh.looksOnRecording
            let name = Camera.newFileName()
            let url = Camera.recordingsFolder.appendingPathComponent(name)
            try? FileManager.default.removeItem(at: url)
            let bitrate = Camera.averageBitrate(video)
            let config = Recorder.Config(
                url: url, videoSettings: video, audioSettings: audio,
                transform: CGAffineTransform(rotationAngle: CGFloat(Double(sh.angle) * .pi / 180)),
                look: useLook ? sh.look : "none", fps: s.fps, width: Int(dims.width), height: Int(dims.height))
            let landscape = sh.angle == 0 || sh.angle == 180
            let info: [String: Any] = [
                "name": name, "codec": codec == .hevc ? "hevc" : "h264", "fps": s.fps, "hdr": s.hdr,
                "width": Int(landscape ? dims.width : dims.height), "height": Int(landscape ? dims.height : dims.width),
                "rotation": sh.angle, "look": useLook ? sh.look : "none", "bitrate": bitrate,
            ]
            self.rec.set(RecState(active: true, name: name, startWall: 0, startedAt: nil, bitrate: bitrate, info: info))
            self.dataQueue.async {
                do {
                    try self.recorder.begin(config)
                } catch {
                    self.rec.set(RecState())
                    self.delegate?.cameraRecordingFailed("Recording couldn't start: \(error.localizedDescription)")
                }
            }
        }
    }

    private func recordingDidStart(_ pts: CMTime) {
        let clock = session.synchronizationClock ?? CMClockGetHostTimeClock()
        let now = CMClockGetTime(clock)
        let wall = Date().timeIntervalSince1970 - (now - pts).seconds
        let name = rec.mutate { r -> String in
            r.startWall = wall
            r.startedAt = Date(timeIntervalSince1970: wall)
            return r.name
        }
        delegate?.cameraRecordingStarted(name: name, startWall: wall * 1000)
    }

    private func recordingDidFail(_ message: String) {
        rec.set(RecState())
        delegate?.cameraRecordingFailed(message)
    }

    func stopRecording() {
        dataQueue.async {
            guard self.recorder.phase == .waiting || self.recorder.phase == .recording else { return }
            self.recorder.finish { result in
                let r = self.rec.get
                self.rec.set(RecState())
                switch result {
                case .success(let done):
                    var info = r.info
                    info["duration"] = finite(done.duration)
                    info["frames"] = done.frames
                    info["dropped"] = done.dropped
                    info["startWall"] = finite(r.startWall * 1000)
                    let size = (try? FileManager.default.attributesOfItem(atPath: done.url.path)[.size] as? NSNumber)?.int64Value ?? 0
                    info["size"] = size
                    self.delegate?.cameraRecordingFinished(info, url: done.url)
                case .failure(let error):
                    self.delegate?.cameraRecordingFailed(error.localizedDescription)
                }
            }
        }
    }

    // MARK: - Frames

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        if output === videoOutput {
            recorder.appendVideo(sampleBuffer)
            makePreview(sampleBuffer)
        } else {
            var avg: Float = -160, peak: Float = -160
            for ch in connection.audioChannels {
                avg = max(avg, ch.averagePowerLevel)
                peak = max(peak, ch.peakHoldLevel)
            }
            audioLevel.set((avg, peak))
            recorder.appendAudio(sampleBuffer)
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didDrop sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {}

    /// A small JPEG of every frame (up to 30 a second) for the PC, while a PC is watching.
    private func makePreview(_ sb: CMSampleBuffer) {
        let sh = shared.get
        guard sh.previewWanted, !previewBusy.get, let pb = CMSampleBufferGetImageBuffer(sb) else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sb)
        if lastPreviewPTS.isValid, (pts - lastPreviewPTS).seconds < 1.0 / 30.0 - 0.004, (pts - lastPreviewPTS).seconds >= 0 { return }
        lastPreviewPTS = pts
        let w = CVPixelBufferGetWidth(pb), h = CVPixelBufferGetHeight(pb)
        let scale = min(1.0, Double(sh.previewSize) / Double(max(w, h)))
        let tw = max(2, Int((Double(w) * scale / 2).rounded()) * 2)
        let th = max(2, Int((Double(h) * scale / 2).rounded()) * 2)
        guard let small = previewBuffer(width: tw, height: th) else { return }
        let scaled = CIImage(cvPixelBuffer: pb).applyingFilter("CILanczosScaleTransform", parameters: [
            kCIInputScaleKey: scale, kCIInputAspectRatioKey: 1.0,
        ])
        ci.render(scaled, to: small, bounds: CGRect(x: 0, y: 0, width: tw, height: th), colorSpace: srgb)
        previewBusy.set(true)
        previewQueue.async { [weak self] in
            guard let self else { return }
            let image = Looks.apply(sh.look, to: CIImage(cvPixelBuffer: small)).oriented(Camera.orientation(for: sh.angle))
            let jpeg = self.ci.jpegRepresentation(of: image, colorSpace: self.srgb, options: [
                CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String): sh.previewQuality,
            ])
            self.previewBusy.set(false)
            if let jpeg { self.delegate?.cameraPreviewFrame(jpeg) }
        }
    }

    private func previewBuffer(width: Int, height: Int) -> CVPixelBuffer? {
        let size = CGSize(width: width, height: height)
        if previewPool == nil || previewPoolSize != size {
            let attrs: [String: Any] = [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: width,
                kCVPixelBufferHeightKey as String: height,
                kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any](),
            ]
            var pool: CVPixelBufferPool?
            CVPixelBufferPoolCreate(nil, [kCVPixelBufferPoolMinimumBufferCountKey as String: 3] as CFDictionary, attrs as CFDictionary, &pool)
            previewPool = pool
            previewPoolSize = size
        }
        guard let pool = previewPool else { return nil }
        var pb: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pb)
        return pb
    }
}
