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
