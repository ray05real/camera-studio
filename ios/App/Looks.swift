import CoreImage

/// Simple looks (no beauty filters): applied to the PC preview, and burned into the recording.
/// Off with HDR or above 60 fps (each 4K frame has to be redrawn, which costs too much at 120 fps).
enum Looks {
    static let all: [(id: String, name: String)] = [
        ("none", "Natural"), ("warm", "Warm"), ("cool", "Cool"), ("vivid", "Vivid"), ("soft", "Soft"),
        ("mono", "Mono"), ("noir", "Noir"), ("fade", "Fade"), ("chrome", "Chrome"),
    ]

    static func apply(_ id: String, to image: CIImage) -> CIImage {
        switch id {
        case "warm":
            return gains(image, r: 1.07, g: 1.0, b: 0.87)
        case "cool":
            return gains(image, r: 0.9, g: 0.99, b: 1.08)
        case "vivid":
            return image.applyingFilter("CIVibrance", parameters: ["inputAmount": 0.55])
                .applyingFilter("CIColorControls", parameters: [kCIInputContrastKey: 1.06])
        case "soft":
            return image.applyingFilter("CIColorControls", parameters: [
                kCIInputSaturationKey: 0.88, kCIInputContrastKey: 0.93, kCIInputBrightnessKey: 0.01,
            ])
        case "mono": return image.applyingFilter("CIPhotoEffectMono")
        case "noir": return image.applyingFilter("CIPhotoEffectNoir")
        case "fade": return image.applyingFilter("CIPhotoEffectFade")
        case "chrome": return image.applyingFilter("CIPhotoEffectChrome")
        default: return image
        }
    }

    private static func gains(_ image: CIImage, r: CGFloat, g: CGFloat, b: CGFloat) -> CIImage {
        image.applyingFilter("CIColorMatrix", parameters: [
            "inputRVector": CIVector(x: r, y: 0, z: 0, w: 0),
            "inputGVector": CIVector(x: 0, y: g, z: 0, w: 0),
            "inputBVector": CIVector(x: 0, y: 0, z: b, w: 0),
        ])
    }
}
