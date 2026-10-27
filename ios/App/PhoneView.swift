import AVFoundation
import SwiftUI

/// The iPhone's own screen. While filming with the back camera it faces away from you, so it mostly says how to
/// connect and then goes black (saves battery and heat); any tap wakes it.
struct PhoneView: View {
    @ObservedObject var model: PhoneModel
    let studio: Studio
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if model.dark { darkScreen } else { mainScreen }
            if let n = model.countdown {
                Text("\(n)")
                    .font(.system(size: 240, weight: .heavy, design: .rounded))
                    .foregroundStyle(.white)
                    .shadow(color: .black.opacity(0.6), radius: 16)
                    .transition(.scale)
            }
        }
        .contentShape(Rectangle())
        .simultaneousGesture(TapGesture().onEnded { model.touched() })
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { UIApplication.shared.isIdleTimerDisabled = true }
        }
        .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
    }

    private var connected: Bool { !model.pcs.isEmpty }

    private var mainScreen: some View {
        VStack(spacing: 14) {
            HStack {
                Text("Camera Studio").font(.system(size: 22, weight: .bold))
                Spacer()
                statusPill
            }
            ZStack(alignment: .topLeading) {
                CameraPreview(session: studio.camera.session)
                    .background(Color(white: 0.08))
                if model.recording { RecBadge(start: model.recStart).padding(10) }
            }
            .aspectRatio(3.0 / 4.0, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))

            if connected {
                Text("Your PC is in control. This screen goes black after 30 seconds to keep the iPhone cool; tap to wake it.")
                    .font(.system(size: 15)).foregroundStyle(.secondary).multilineTextAlignment(.center)
            } else {
                VStack(spacing: 6) {
                    Text("Open Camera Studio on your PC. If it doesn't find this iPhone, type this address there:")
                        .font(.system(size: 15)).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    Text(model.address)
                        .font(.system(size: 38, weight: .bold, design: .rounded)).monospacedDigit()
                        .textSelection(.enabled)
                    Text("port \(String(Wire.port)) · or plug in the USB cable")
                        .font(.system(size: 14)).foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(14)
                .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color(white: 0.11)))
            }

            if model.status != "running" {
                Text(model.status).font(.system(size: 15, weight: .semibold)).foregroundStyle(.orange)
                    .multilineTextAlignment(.center)
            }
            if let problem = model.problem {
                Text(problem).font(.system(size: 15, weight: .semibold)).foregroundStyle(.orange)
                    .multilineTextAlignment(.center)
            }
            if let message = model.message {
                Text(message).font(.system(size: 15)).foregroundStyle(.white.opacity(0.85))
                    .multilineTextAlignment(.center)
            }
            Spacer(minLength: 0)
            HStack(spacing: 12) {
                Button {
                    studio.toggleRecording()
                } label: {
                    Label(model.recording ? "Stop" : "Record", systemImage: model.recording ? "stop.fill" : "record.circle")
                        .font(.system(size: 17, weight: .semibold))
                        .frame(maxWidth: .infinity, minHeight: 50)
                        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(model.recording ? Color.red : Color(white: 0.16)))
                }
                Button {
                    model.dark = true
                } label: {
                    Label("Black screen", systemImage: "moon.fill")
                        .font(.system(size: 17, weight: .semibold))
                        .frame(maxWidth: .infinity, minHeight: 50)
                        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color(white: 0.16)))
                }
            }
            .foregroundStyle(.white)
            Toggle("Go black by itself when the PC is connected", isOn: $model.autoDark)
                .font(.system(size: 14)).foregroundStyle(.secondary)
                .tint(.green)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
    }

    private var statusPill: some View {
        HStack(spacing: 6) {
            Circle().fill(connected ? Color.green : Color.orange).frame(width: 9, height: 9)
            Text(connected ? (model.usb ? "PC connected · USB" : "PC connected · Wi-Fi") : "Waiting for your PC")
                .font(.system(size: 13, weight: .semibold))
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(Capsule().fill(Color(white: 0.13)))
    }

    private var darkScreen: some View {
        VStack(spacing: 8) {
            Spacer()
            if model.recording {
                RecBadge(start: model.recStart).opacity(0.7)
            }
            Text(connected ? "Camera Studio · PC connected · tap to wake" : "Camera Studio · tap to wake")
                .font(.system(size: 13)).foregroundStyle(.white.opacity(0.25))
        }
        .padding(.bottom, 30)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black)
    }
}

struct RecBadge: View {
    let start: Date?

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.5)) { context in
            HStack(spacing: 6) {
                Circle().fill(Color.red).frame(width: 10, height: 10)
                Text(RecBadge.format(start.map { context.date.timeIntervalSince($0) } ?? 0))
                    .font(.system(size: 15, weight: .bold)).monospacedDigit()
            }
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background(Capsule().fill(Color.black.opacity(0.6)))
            .foregroundStyle(.white)
        }
    }

    static func format(_ t: Double) -> String {
        let s = max(0, Int(t))
        return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60)
                         : String(format: "%02d:%02d", s / 60, s % 60)
    }
}

/// The iPhone's own small view of the camera (Apple's preview layer, upright for the portrait screen).
struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.previewLayer.session = session
        view.previewLayer.videoGravity = .resizeAspect
        return view
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {}
}

final class PreviewView: UIView {
    override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
    var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }

    override func layoutSubviews() {
        super.layoutSubviews()
        if let c = previewLayer.connection, c.isVideoRotationAngleSupported(90) { c.videoRotationAngle = 90 }
    }
}
