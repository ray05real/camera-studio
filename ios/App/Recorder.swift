import AVFoundation
import CoreImage

/// Writes the camera's own frames and sound into a .mov at full quality (AVAssetWriter), so the same frames can
/// also feed the small preview to the PC and, if a look is on, be redrawn with it. Used on the camera's data queue only.
final class Recorder {
    enum Phase { case idle, waiting, recording, finishing }

    struct Config {
        var url: URL
        var videoSettings: [String: Any]
        var audioSettings: [String: Any]?
        var transform: CGAffineTransform
        var look: String
        var fps: Double
        var width: Int
        var height: Int
    }

    struct Result {
        var url: URL
        var frames: Int
        var dropped: Int
        var duration: Double
    }

    private(set) var phase: Phase = .idle
    private var writer: AVAssetWriter?
    private var videoIn: AVAssetWriterInput?
    private var audioIn: AVAssetWriterInput?
    private var adaptor: AVAssetWriterInputPixelBufferAdaptor?
    private var look = "none"
    private var startPTS = CMTime.invalid
    private var lastVideoPTS = CMTime.invalid
    private var frameDuration = CMTime(value: 1, timescale: 30)
    private var frames = 0
    private(set) var dropped = 0
    private let ci: CIContext
    private let queue: DispatchQueue
    private let rec709 = CGColorSpace(name: CGColorSpace.itur_709) ?? CGColorSpaceCreateDeviceRGB()

    /// Called on the data queue with the first frame's time, once the file has really started.
    var onStarted: ((CMTime) -> Void)?
    /// Called on the data queue if writing fails part-way (e.g. the phone is full).
    var onFailed: ((String) -> Void)?

    init(ci: CIContext, queue: DispatchQueue) {
        self.ci = ci
        self.queue = queue
    }

    func begin(_ c: Config) throws {
        let w = try AVAssetWriter(outputURL: c.url, fileType: .mov)
        let v = AVAssetWriterInput(mediaType: .video, outputSettings: c.videoSettings)
        v.expectsMediaDataInRealTime = true
        v.transform = c.transform
        guard w.canAdd(v) else { throw RecorderError("The video settings weren't accepted.") }
        w.add(v)
        adaptor = nil
        if c.look != "none" {
            adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: v, sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: c.width,
                kCVPixelBufferHeightKey as String: c.height,
                kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any](),
            ])
        }
        audioIn = nil
        if let a = c.audioSettings {
            let input = AVAssetWriterInput(mediaType: .audio, outputSettings: a)
            input.expectsMediaDataInRealTime = true
            if w.canAdd(input) { w.add(input); audioIn = input }
        }
        guard w.startWriting() else { throw w.error ?? RecorderError("The video file couldn't be started.") }
        writer = w
        videoIn = v
        look = c.look
        frameDuration = CMTime(value: 1, timescale: CMTimeScale(max(1, c.fps.rounded())))
        startPTS = .invalid
        lastVideoPTS = .invalid
        frames = 0
        dropped = 0
        phase = .waiting
    }

    func appendVideo(_ sb: CMSampleBuffer) {
        guard phase == .waiting || phase == .recording, let w = writer, let v = videoIn else { return }
        if w.status == .failed {
            fail(w.error?.localizedDescription ?? "Writing the video failed.")
            return
        }
        let pts = CMSampleBufferGetPresentationTimeStamp(sb)
        if phase == .waiting {
            w.startSession(atSourceTime: pts)
            startPTS = pts
            phase = .recording
            onStarted?(pts)
        }
        guard v.isReadyForMoreMediaData else { dropped += 1; return }
        if let adaptor, let source = CMSampleBufferGetImageBuffer(sb), let pool = adaptor.pixelBufferPool {
            var out: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, pool, &out)
            guard let out else { dropped += 1; return }
            let image = Looks.apply(look, to: CIImage(cvPixelBuffer: source))
            ci.render(image, to: out, bounds: CGRect(x: 0, y: 0, width: CVPixelBufferGetWidth(out),
                                                     height: CVPixelBufferGetHeight(out)), colorSpace: rec709)
            CVBufferSetAttachment(out, kCVImageBufferColorPrimariesKey, kCVImageBufferColorPrimaries_ITU_R_709_2, .shouldPropagate)
            CVBufferSetAttachment(out, kCVImageBufferTransferFunctionKey, kCVImageBufferTransferFunction_ITU_R_709_2, .shouldPropagate)
            CVBufferSetAttachment(out, kCVImageBufferYCbCrMatrixKey, kCVImageBufferYCbCrMatrix_ITU_R_709_2, .shouldPropagate)
            if adaptor.append(out, withPresentationTime: pts) { frames += 1; lastVideoPTS = pts } else { dropped += 1 }
        } else {
            if v.append(sb) { frames += 1; lastVideoPTS = pts } else { dropped += 1 }
        }
    }

    func appendAudio(_ sb: CMSampleBuffer) {
        guard phase == .recording, let a = audioIn, a.isReadyForMoreMediaData else { return }
        let pts = CMSampleBufferGetPresentationTimeStamp(sb)
        guard startPTS.isValid, pts >= startPTS else { return }
        a.append(sb)
    }

    /// Finishes the file. `done` runs on the data queue.
    func finish(_ done: @escaping (Swift.Result<Result, Error>) -> Void) {
        guard let w = writer, phase == .waiting || phase == .recording else {
            done(.failure(RecorderError("Nothing was recording.")))
            return
        }
        if phase == .waiting || !lastVideoPTS.isValid {
            w.cancelWriting()
            reset()
            done(.failure(RecorderError("No pictures reached the recording.")))
            return
        }
        phase = .finishing
        videoIn?.markAsFinished()
        audioIn?.markAsFinished()
        let end = lastVideoPTS + frameDuration
        w.endSession(atSourceTime: end)
        let result = Result(url: w.outputURL, frames: frames, dropped: dropped, duration: (end - startPTS).seconds)
        w.finishWriting { [weak self] in
            self?.queue.async {
                self?.reset()
                if w.status == .completed {
                    done(.success(result))
                } else {
                    done(.failure(w.error ?? RecorderError("The video couldn't be finished.")))
                }
            }
        }
    }

    /// Drops the video being written (after an error).
    func abandon() {
        if let w = writer, w.status == .writing { w.cancelWriting() }
        reset()
    }

    private func fail(_ message: String) {
        writer?.cancelWriting()
        reset()
        onFailed?(message)
    }

    private func reset() {
        writer = nil
        videoIn = nil
        audioIn = nil
        adaptor = nil
        phase = .idle
    }
}

struct RecorderError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
