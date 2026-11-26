// Рендер HTML в PNG через WKWebView (без симулятора) + выполнение JS.
//
//   swift render.swift <url> <out.png> [width] [height] [waitMs] [js]
//
// Печатает в stdout результат JS (JSON), если он передан.
import Cocoa
import WebKit

final class Renderer: NSObject, WKNavigationDelegate {
    let web: WKWebView
    let window: NSWindow
    let out: String
    let wait: TimeInterval
    let js: String?
    var finished = false

    init(url: URL, width: CGFloat, height: CGFloat, scale: CGFloat, out: String, wait: TimeInterval, js: String?) {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .nonPersistent()
        cfg.suppressesIncrementalRendering = false
        cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: height), configuration: cfg)
        window = NSWindow(contentRect: NSRect(x: -4000, y: -4000, width: width, height: height),
                          styleMask: [.borderless], backing: .buffered, defer: false)
        self.out = out
        self.wait = wait
        self.js = js
        super.init()
        window.contentView = web
        window.orderBack(nil)
        web.navigationDelegate = self
        web.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
        DispatchQueue.main.asyncAfter(deadline: .now() + 25) { [weak self] in
            self?.snapshot()
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in
            self?.snapshot()
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        FileHandle.standardError.write("load failed: \(error)\n".data(using: .utf8)!)
        snapshot()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        FileHandle.standardError.write("load failed: \(error)\n".data(using: .utf8)!)
        snapshot()
    }

    func snapshot() {
        guard !finished else { return }
        finished = true

        let shoot = {
            let cfg = WKSnapshotConfiguration()
            cfg.rect = self.web.bounds
            self.web.takeSnapshot(with: cfg) { image, error in
                if let image = image, let tiff = image.tiffRepresentation,
                   let rep = NSBitmapImageRep(data: tiff),
                   let png = rep.representation(using: .png, properties: [:]) {
                    try? png.write(to: URL(fileURLWithPath: self.out))
                    print("saved \(self.out) \(Int(image.size.width))x\(Int(image.size.height))")
                } else {
                    FileHandle.standardError.write("snapshot failed: \(String(describing: error))\n".data(using: .utf8)!)
                }
                NSApp.terminate(nil)
            }
        }

        if let js = js, !js.isEmpty {
            web.evaluateJavaScript(js) { result, error in
                if let error = error {
                    print("JS_ERROR \(error)")
                } else if let result = result {
                    if JSONSerialization.isValidJSONObject(result),
                       let data = try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .withoutEscapingSlashes]),
                       let text = String(data: data, encoding: .utf8) {
                        print(text)
                    } else {
                        print(String(describing: result))
                    }
                }
                shoot()
            }
        } else {
            shoot()
        }
    }
}

let args = CommandLine.arguments
guard args.count >= 3, let url = URL(string: args[1]) else {
    print("usage: render <url> <out.png> [width] [height] [waitMs] [js]")
    exit(2)
}
let width = CGFloat(Double(args.count > 3 ? args[3] : "390") ?? 390)
let height = CGFloat(Double(args.count > 4 ? args[4] : "844") ?? 844)
let wait = (Double(args.count > 5 ? args[5] : "1500") ?? 1500) / 1000
let js = args.count > 6 ? args[6] : nil

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let renderer = Renderer(url: url, width: width, height: height, scale: 2, out: args[2], wait: wait, js: js)
_ = renderer
app.run()
