import Foundation
import Network

protocol ServerDelegate: AnyObject {
    func server(_ server: Server, received message: [String: Any], from peer: Peer)
    func serverPeersChanged(_ server: Server)
    func serverProblem(_ text: String?)
}

/// One PC connection: either the control line (settings, state, preview) or a file copy.
final class Peer {
    let id = UUID()
    let conn: NWConnection
    var role = "new"               // new | control | download (network queue only)
    var pcName = ""
    private var previewInFlight = false

    init(conn: NWConnection) { self.conn = conn }

    /// Connections through the USB cable arrive from the iPhone itself (Apple's usbmux forwards them).
    var isUSB: Bool {
        if case .hostPort(let host, _) = conn.endpoint {
            let h = "\(host)"
            return h.hasPrefix("127.") || h.hasPrefix("::1") || h.hasPrefix("::ffff:127.")
        }
        return false
    }

    func send(_ object: [String: Any]) {
        guard let frame = Wire.jsonFrame(object) else { return }
        conn.send(content: frame, completion: .contentProcessed { _ in })
    }

    /// Drops the picture if the last one hasn't gone out yet, so a slow Wi-Fi never builds up a delay.
    func sendPreview(_ jpeg: Data) {
        guard !previewInFlight else { return }
        previewInFlight = true
        conn.send(content: Wire.frame(Wire.jpeg, jpeg), completion: .contentProcessed { [weak self] _ in
            self?.previewInFlight = false
        })
    }
}

/// Listens on port 47100 (and announces itself on the network as _camstudio._tcp, so the PC can find it).
final class Server {
    weak var delegate: ServerDelegate?
    let queue: DispatchQueue
    private var listener: NWListener?
    private(set) var peers: [Peer] = []
    private let fileQueue = DispatchQueue(label: "studio.files")

    init(queue: DispatchQueue) { self.queue = queue }

    var controlPeers: [Peer] { peers.filter { $0.role == "control" } }

    func start() {
        queue.async { self.makeListener() }
    }

    private func makeListener() {
        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true
        let params = NWParameters(tls: nil, tcp: tcp)
        params.allowLocalEndpointReuse = true
        params.includePeerToPeer = false
        guard let port = NWEndpoint.Port(rawValue: Wire.port) else { return }
        do {
            let l = try NWListener(using: params, on: port)
            l.service = NWListener.Service(name: "Camera Studio (\(DeviceInfo.modelName))", type: Wire.serviceType)
            l.stateUpdateHandler = { [weak self] state in self?.listenerChanged(state) }
            l.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
            l.start(queue: queue)
            listener = l
        } catch {
            delegate?.serverProblem("Couldn't open port \(Wire.port): \(error.localizedDescription)")
            queue.asyncAfter(deadline: .now() + 3) { self.makeListener() }
        }
    }

    private func listenerChanged(_ state: NWListener.State) {
        switch state {
        case .ready:
            delegate?.serverProblem(nil)
        case .waiting(let error):
            delegate?.serverProblem(Server.describe(error))
        case .failed(let error):
            delegate?.serverProblem(Server.describe(error))
            listener?.cancel()
            listener = nil
            queue.asyncAfter(deadline: .now() + 2) { self.makeListener() }
        default:
            break
        }
    }

    static func describe(_ error: NWError) -> String {
        if case .dns(let code) = error, code == -65570 {
            return "Local Network is off for Camera Studio. Turn it on: Settings › Privacy & Security › Local Network."
        }
        return "Network problem: \(error.localizedDescription)"
    }

    private func accept(_ conn: NWConnection) {
        let peer = Peer(conn: conn)
        peers.append(peer)
        conn.stateUpdateHandler = { [weak self, weak peer] state in
            guard let self, let peer else { return }
            switch state {
            case .failed, .cancelled: self.remove(peer)
            default: break
            }
        }
        conn.start(queue: queue)
        read(peer)
    }

    func close(_ peer: Peer) {
        peer.conn.cancel()
        remove(peer)
    }

    private func remove(_ peer: Peer) {
        guard let i = peers.firstIndex(where: { $0 === peer }) else { return }
        peers.remove(at: i)
        if peer.role == "control" { delegate?.serverPeersChanged(self) }
    }

    func markControl(_ peer: Peer) {
        peer.role = "control"
        delegate?.serverPeersChanged(self)
    }

    private func read(_ peer: Peer) {
        peer.conn.receive(minimumIncompleteLength: 5, maximumLength: 5) { [weak self] data, _, _, error in
            guard let self else { return }
            guard let data, data.count == 5, error == nil else { self.close(peer); return }
            let b = [UInt8](data)
            let length = Int(b[0]) << 24 | Int(b[1]) << 16 | Int(b[2]) << 8 | Int(b[3])
            let type = b[4]
            let bodyLength = length - 1
            guard bodyLength >= 0, bodyLength < 8_000_000 else { self.close(peer); return }
            if bodyLength == 0 {
                self.handle(peer, type, Data())
                self.read(peer)
                return
            }
            peer.conn.receive(minimumIncompleteLength: bodyLength, maximumLength: bodyLength) { body, _, _, error in
                guard let body, body.count == bodyLength, error == nil else { self.close(peer); return }
                self.handle(peer, type, body)
                self.read(peer)
            }
        }
    }

    private func handle(_ peer: Peer, _ type: UInt8, _ body: Data) {
        guard type == Wire.json, let message = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] else { return }
        delegate?.server(self, received: message, from: peer)
    }

    func broadcast(_ object: [String: Any]) {
        guard let frame = Wire.jsonFrame(object) else { return }
        for p in controlPeers { p.conn.send(content: frame, completion: .contentProcessed { _ in }) }
    }

    func broadcastPreview(_ jpeg: Data) {
        for p in controlPeers { p.sendPreview(jpeg) }
    }

    /// Copies a recording to the PC on its own connection, 1 MB at a time, from `offset` (to carry on after a break).
    func serveFile(_ url: URL, offset: Int64, to peer: Peer) {
        peer.role = "download"
        guard let handle = try? FileHandle(forReadingFrom: url) else {
            peer.send(["op": "fileError", "message": "That video isn't on the iPhone any more."])
            return
        }
        let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.int64Value ?? 0
        let start = max(0, min(offset, size))
        try? handle.seek(toOffset: UInt64(start))
        peer.send(["op": "file", "name": url.lastPathComponent, "size": size, "offset": start])
        let conn = peer.conn
        func next() {
            fileQueue.async {
                let chunk = try? handle.read(upToCount: 1 << 20)
                if let chunk, !chunk.isEmpty {
                    conn.send(content: Wire.frame(Wire.chunk, chunk), completion: .contentProcessed { error in
                        if error == nil { next() } else { try? handle.close() }
                    })
                } else {
                    try? handle.close()
                    peer.send(["op": "eof"])
                }
            }
        }
        next()
    }
}
