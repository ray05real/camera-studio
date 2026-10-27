import SwiftUI
import UIKit

@main
struct CameraStudioApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            PhoneView(model: Studio.shared.model, studio: Studio.shared)
                .preferredColorScheme(.dark)
                .statusBarHidden(true)
                .persistentSystemOverlays(.hidden)
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // The camera only runs while the app is on screen, so the screen must never lock by itself.
        application.isIdleTimerDisabled = true
        UIDevice.current.isBatteryMonitoringEnabled = true
        Studio.shared.start()
        return true
    }
}
