import AVFoundation
import Foundation
import Photos
import UIKit

/// What the iPhone's own screen shows. Main thread only.
final class PhoneModel: ObservableObject {
    @Published var status = "Starting the camera…"
    @Published var pcs: [String] = []
    @Published var usb = false
    @Published var address = "—"
    @Published var recording = false
    @Published var recStart: Date?
    @Published var countdown: Int?
    @Published var message: String?
    @Published var problem: String?
    @Published var dark = false
    @Published var autoDark = true
    var lastTouch = Date()

    func touched() {
        lastTouch = Date()
        if dark { dark = false }
    }
}

/// Joins the camera and the PC connection: answers the PC's messages and sends it the state, preview and videos.
final class Studio: CameraDelegate, ServerDelegate {
    static let shared = Studio()

    let model = PhoneModel()
    let camera = Camera()
    private let queue = DispatchQueue(label: "studio.net")
    private lazy var server = Server(queue: queue)
    private var liveTimer: DispatchSourceTimer?
    private var screenTimer: Timer?
    private var countdownTimer: Timer?
    private var messageClear: DispatchWorkItem?
    private var stateScheduled = false
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private let phoneInfo = Locked<[String: Any]>([:])

    func start() {
        camera.delegate = self
        server.delegate = self
        server.start()
        requestPermissions()
        refreshPhoneInfo()
        screenTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.everySecond() }
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 0.5, repeating: 0.1)
        t.setEventHandler { [weak self] in self?.sendLive() }
        t.resume()
        liveTimer = t
        let nc = NotificationCenter.default
        nc.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            self.endBackgroundTask()
            self.backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Finish the video") { self.endBackgroundTask() }
            DispatchQueue.main.asyncAfter(deadline: .now() + 25) { self.endBackgroundTask() }
        }
        nc.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
            UIApplication.shared.isIdleTimerDisabled = true
            self?.endBackgroundTask()
            self?.camera.resume()
        }
        nc.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: nil) { [weak self] _ in
            self?.scheduleState()
        }
    }

    private func endBackgroundTask() {
        if backgroundTask != .invalid {
            UIApplication.shared.endBackgroundTask(backgroundTask)
            backgroundTask = .invalid
        }
    }

    private func requestPermissions() {
        AVCaptureDevice.requestAccess(for: .video) { video in
            AVCaptureDevice.requestAccess(for: .audio) { audio in
                if video {
                    self.camera.start(withMic: audio)
                } else {
                    DispatchQueue.main.async {
                        self.model.status = "Camera access is off. Turn it on: Settings › Apps › Camera Studio › Camera."
                    }
                }
                if !audio { self.cameraMessage("The microphone is off for Camera Studio, so videos will have no iPhone sound.") }
                PHPhotoLibrary.requestAuthorization(for: .addOnly) { _ in }
            }
        }
    }

    // MARK: - Timers

    private func everySecond() {
        refreshPhoneInfo()
        model.address = DeviceInfo.wifiAddress() ?? "not on Wi-Fi"
        if model.autoDark, !model.pcs.isEmpty, !model.dark, model.countdown == nil,
           Date().timeIntervalSince(model.lastTouch) > 30 {
            model.dark = true
        }
    }

    /// Main thread: battery and the like (UIKit wants these read there), kept for the network queue.
    private func refreshPhoneInfo() {
        let device = UIDevice.current
        phoneInfo.set([
            "model": DeviceInfo.modelName,
            "battery": finite(device.batteryLevel),
            "charging": device.batteryState == .charging || device.batteryState == .full,
            "thermal": DeviceInfo.thermal,
            "free": DeviceInfo.freeBytes(),
            "address": DeviceInfo.wifiAddress() ?? "",
            "port": Int(Wire.port),
        ])
    }

    private func sendLive() {
        guard !server.controlPeers.isEmpty else { return }
        var live = camera.live()
        live["op"] = "live"
        live["phone"] = phoneInfo.get
        server.broadcast(live)
    }

    // MARK: - State

    private func scheduleState() {
        queue.async {
            guard !self.stateScheduled else { return }
            self.stateScheduled = true
            self.queue.asyncAfter(deadline: .now() + 0.05) {
                self.stateScheduled = false
                self.sendState(to: nil)
            }
        }
    }

    private func sendState(to peer: Peer?) {
        camera.state { state in
            self.queue.async {
                var s = state
                s["op"] = "state"
                s["phone"] = self.phoneInfo.get
                if let peer { peer.send(s) } else { self.server.broadcast(s) }
            }
            let status = state["status"] as? String ?? ""
            DispatchQueue.main.async { self.model.status = status }
        }
    }

    private func pendingFiles() -> [[String: Any]] {
        let current = camera.recordingName
        let urls = (try? FileManager.default.contentsOfDirectory(at: Camera.recordingsFolder,
                                                                 includingPropertiesForKeys: [.fileSizeKey])) ?? []
        return urls
            .filter { $0.pathExtension.lowercased() == "mov" && $0.lastPathComponent != current }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
            .map { url in
                let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
                return ["name": url.lastPathComponent, "size": size]
            }
    }

    private func sendFiles(to peer: Peer?) {
        let message: [String: Any] = ["op": "files", "list": pendingFiles()]
        if let peer { peer.send(message) } else { server.broadcast(message) }
    }

    /// A file name from the PC, checked so it can only ever point inside the recordings folder.
    private func recordingURL(_ name: String) -> URL? {
        let clean = URL(fileURLWithPath: name).lastPathComponent
        guard clean == name, clean.lowercased().hasSuffix(".mov") else { return nil }
        let url = Camera.recordingsFolder.appendingPathComponent(clean)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    // MARK: - Messages from the PC

    func server(_ server: Server, received m: [String: Any], from peer: Peer) {
        func number(_ key: String) -> Double? { (m[key] as? NSNumber)?.doubleValue }
        switch m["op"] as? String ?? "" {
        case "hello":
            peer.pcName = m["pc"] as? String ?? "PC"
            server.markControl(peer)
            peer.send(["op": "hello", "app": "CameraStudio", "version": 1, "model": DeviceInfo.modelName,
                       "port": Int(Wire.port), "usb": peer.isUSB])
            sendState(to: peer)
            sendFiles(to: peer)
        case "ping":
            peer.send(["op": "pong", "t0": m["t0"] ?? 0, "phone": Date().timeIntervalSince1970 * 1000])
        case "state":
            sendState(to: peer)
        case "set":
            if let changes = m["changes"] as? [String: Any] { camera.update(changes) }
        case "zoom":
            camera.zoom(to: number("value") ?? 1, smooth: m["smooth"] as? Bool ?? false)
        case "focusAt":
            camera.focus(atDisplay: CGPoint(x: number("x") ?? 0.5, y: number("y") ?? 0.5))
        case "record":
            camera.startRecording()
        case "stop":
            camera.stopRecording()
        case "countdown":
            let seconds = Int(number("seconds") ?? 3)
            DispatchQueue.main.async { self.showCountdown(seconds) }
        case "cancelCountdown":
            DispatchQueue.main.async { self.showCountdown(0) }
        case "download":
            if let name = m["name"] as? String, let url = recordingURL(name) {
                server.serveFile(url, offset: Int64(number("offset") ?? 0), to: peer)
            } else {
                peer.send(["op": "fileError", "message": "That video isn't on the iPhone any more."])
            }
        case "received":
            if let name = m["name"] as? String, let url = recordingURL(name) {
                try? FileManager.default.removeItem(at: url)
            }
            sendFiles(to: nil)
        case "files":
            sendFiles(to: peer)
        default:
            break
        }
    }

    func serverPeersChanged(_ server: Server) {
        let peers = server.controlPeers
        camera.setPreviewWanted(!peers.isEmpty)
        let names = peers.map { $0.pcName.isEmpty ? "PC" : $0.pcName }
        let usb = peers.contains(where: { $0.isUSB })
        DispatchQueue.main.async {
            self.model.pcs = names
            self.model.usb = usb
            if names.isEmpty { self.model.dark = false }
        }
    }

    func serverProblem(_ text: String?) {
        DispatchQueue.main.async { self.model.problem = text }
    }

    // MARK: - Camera events

    func cameraStateChanged() {
        scheduleState()
    }

    func cameraPreviewFrame(_ jpeg: Data) {
        queue.async { self.server.broadcastPreview(jpeg) }
    }

    func cameraRecordingStarted(name: String, startWall: Double) {
        queue.async { self.server.broadcast(["op": "recStarted", "name": name, "startWall": startWall]) }
        DispatchQueue.main.async {
            self.model.recording = true
            self.model.recStart = Date(timeIntervalSince1970: startWall / 1000)
            self.showCountdown(0)
        }
        scheduleState()
    }

    func cameraRecordingFinished(_ info: [String: Any], url: URL) {
        var message = info
        message["op"] = "recStopped"
        queue.async {
            self.server.broadcast(message)
            self.sendFiles(to: nil)
        }
        DispatchQueue.main.async {
            self.model.recording = false
            self.model.recStart = nil
        }
        scheduleState()
        saveToPhotos(url)
    }

    func cameraRecordingFailed(_ message: String) {
        queue.async { self.server.broadcast(["op": "recFailed", "message": message]) }
        DispatchQueue.main.async {
            self.model.recording = false
            self.model.recStart = nil
            self.show(message)
        }
        scheduleState()
    }

    func cameraMessage(_ text: String) {
        queue.async { self.server.broadcast(["op": "message", "text": text]) }
        DispatchQueue.main.async { self.show(text) }
    }

    // MARK: - Photos, countdown, messages

    private func saveToPhotos(_ url: URL) {
        let name = url.lastPathComponent
        let report: (Bool, String) -> Void = { ok, text in
            self.queue.async { self.server.broadcast(["op": "photos", "name": name, "ok": ok, "message": text]) }
        }
        let save = {
            PHPhotoLibrary.shared().performChanges({
                let request = PHAssetCreationRequest.forAsset()
                let options = PHAssetResourceCreationOptions()
                options.shouldMoveFile = false
                request.addResource(with: .video, fileURL: url, options: options)
            }) { ok, error in
                report(ok, ok ? "Saved to Photos" : "Not saved to Photos: \(error?.localizedDescription ?? "unknown error")")
            }
        }
        switch PHPhotoLibrary.authorizationStatus(for: .addOnly) {
        case .authorized, .limited:
            save()
        case .notDetermined:
            PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
                if status == .authorized || status == .limited { save() } else { report(false, "Photos access is off for Camera Studio.") }
            }
        default:
            report(false, "Photos access is off for Camera Studio (Settings › Apps › Camera Studio › Photos).")
        }
    }

    /// Main thread. 0 cancels.
    func showCountdown(_ seconds: Int) {
        countdownTimer?.invalidate()
        countdownTimer = nil
        guard seconds > 0 else { model.countdown = nil; return }
        model.touched()
        model.countdown = seconds
        countdownTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] timer in
            guard let self else { timer.invalidate(); return }
            let next = (self.model.countdown ?? 1) - 1
            if next <= 0 {
                self.model.countdown = nil
                timer.invalidate()
            } else {
                self.model.countdown = next
            }
        }
    }

    /// Main thread.
    private func show(_ text: String) {
        model.message = text
        messageClear?.cancel()
        let clear = DispatchWorkItem { [weak self] in self?.model.message = nil }
        messageClear = clear
        DispatchQueue.main.asyncAfter(deadline: .now() + 8, execute: clear)
    }

    // MARK: - Buttons on the iPhone

    func toggleRecording() {
        if camera.isRecording { camera.stopRecording() } else { camera.startRecording() }
    }
}
