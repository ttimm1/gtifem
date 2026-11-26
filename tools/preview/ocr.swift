import Foundation
import Vision
import AppKit

for path in CommandLine.arguments.dropFirst() {
    guard let image = NSImage(contentsOfFile: path),
          let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        print("\(path): cannot open"); continue
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLanguages = ["ru-RU", "en-US"]
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    let handler = VNImageRequestHandler(cgImage: cg, options: [:])
    try? handler.perform([request])
    let lines = (request.results ?? []).compactMap { observation -> String? in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        return candidate.string
    }
    print("== \(URL(fileURLWithPath: path).lastPathComponent)")
    for line in lines { print("   \(line)") }
}
