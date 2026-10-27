// Regenerate with: swift scripts/render-macos-icon.swift
// Keep the web logo intact; macOS needs its own transparent, inset icon canvas.
import AppKit

let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
let source = root.appendingPathComponent("packages/ui/public/vonvon-logo.png")
let output = root.appendingPathComponent("packages/desktop/assets/macos-icon.png")
guard let image = NSImage(contentsOf: source),
      let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
      ), let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
    fatalError("Cannot load the brand logo or create the macOS icon canvas")
}
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = context
context.imageInterpolation = .high
NSColor.clear.setFill()
NSRect(x: 0, y: 0, width: 1024, height: 1024).fill(using: .copy)
// Match the visual size of native Dock icons, with transparent outer padding.
let face = NSRect(x: 64, y: 64, width: 896, height: 896)
NSBezierPath(roundedRect: face, xRadius: 200, yRadius: 200).addClip()
image.draw(in: face, from: .zero, operation: .copy, fraction: 1)
context.flushGraphics()
NSGraphicsContext.restoreGraphicsState()
guard let png = bitmap.representation(using: .png, properties: [:]) else {
    fatalError("Cannot encode the macOS icon")
}
try png.write(to: output)
print(output.path)

// Supply electron-builder with an ICNS rather than letting it resize the PNG.
// Its generated 16px and 32px representations have appeared corrupted in releases.
let iconset = FileManager.default.temporaryDirectory
    .appendingPathComponent("vonvon-\(UUID().uuidString).iconset", isDirectory: true)
try FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: iconset) }
func run(_ executable: String, _ arguments: [String]) throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    try process.run()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
        fatalError("\(executable) failed with status \(process.terminationStatus)")
    }
}
for size in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let pixels = size * scale
        let suffix = scale == 2 ? "@2x" : ""
        let target = iconset.appendingPathComponent("icon_\(size)x\(size)\(suffix).png")
        try run("/usr/bin/sips", ["-z", "\(pixels)", "\(pixels)", output.path, "--out", target.path])
    }
}
let icns = root.appendingPathComponent("packages/desktop/assets/macos-icon.icns")
try run("/usr/bin/iconutil", ["-c", "icns", iconset.path, "-o", icns.path])
print(icns.path)
