import Foundation

struct FocusSettings: Codable, Equatable {
    var mode = "auto"          // auto | locked | manual
    var lens: Float = 0.5      // manual lens position, 0 = closest, 1 = furthest
}

struct ExposureSettings: Codable, Equatable {
    var mode = "auto"          // auto | locked | manual
    var bias: Float = 0        // brightness in auto, in EV
    var iso: Float = 200
    var shutter: Double = 1.0 / 50
}

struct WhiteBalanceSettings: Codable, Equatable {
    var mode = "auto"          // auto | locked | manual
    var temp: Float = 5000     // kelvin
    var tint: Float = 0
}

/// Everything the PC can change. The PC sends partial changes ({"op":"set","changes":{...}}), merged in here.
struct CamSettings: Codable, Equatable {
    var position = "back"           // back | front
    var lens = "auto"               // auto (all lenses, seamless zoom) | ultrawide | wide | tele
    var resolution = "4k"           // 4k | 1080p
    var fps: Double = 30
    var hdr = false
    var codec = "hevc"              // hevc | h264
    var quality = "standard"        // standard (Apple's data rate, like the Camera app) | high (2.5x)
    var orientation = "horizontal"  // horizontal | vertical
    var stabilization = "off"       // off | standard | cinematic | extended
    var look = "none"
    var torch: Float = 0            // 0 = off, else brightness up to 1
    var zoom: Double = 1            // as the Camera app shows it (0.5×, 1×, 2×, 5×)
    var focus = FocusSettings()
    var exposure = ExposureSettings()
    var wb = WhiteBalanceSettings()
    var micInput = ""               // "" = automatic, else an audio input's id
    var micSource = ""              // "" = automatic, else which built-in mic (bottom / front / back)
    var previewSize = 1280          // long side of the PC preview, in pixels
    var previewQuality = 0.7        // JPEG quality of the PC preview

    func dictionary() -> [String: Any] {
        guard let data = try? JSONEncoder().encode(self),
              let dict = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return [:] }
        return dict
    }

    /// The settings with `changes` written over them (one level deep for focus / exposure / wb).
    /// Anything that doesn't fit (an unknown key, a wrong type) leaves the settings as they were.
    func merged(_ changes: [String: Any]) -> CamSettings {
        var dict = dictionary()
        for (key, value) in changes {
            if let sub = value as? [String: Any], var current = dict[key] as? [String: Any] {
                for (k, v) in sub { current[k] = v }
                dict[key] = current
            } else if dict[key] != nil {
                dict[key] = value
            }
        }
        guard JSONSerialization.isValidJSONObject(dict),
              let data = try? JSONSerialization.data(withJSONObject: dict),
              let result = try? JSONDecoder().decode(CamSettings.self, from: data) else { return self }
        return result
    }

    static func load() -> CamSettings {
        guard let data = UserDefaults.standard.data(forKey: "settings"),
              let saved = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return CamSettings() }
        return CamSettings().merged(saved)
    }

    func save() {
        if let data = try? JSONEncoder().encode(self) { UserDefaults.standard.set(data, forKey: "settings") }
    }
}
