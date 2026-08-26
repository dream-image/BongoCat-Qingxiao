#!/usr/bin/env swift

import AppKit
import CoreImage
import Foundation
import Vision

// 生成素材时图像模型只能稳定输出纯色背景，不能可靠地产生真实 Alpha。
// 这里使用 macOS Vision 的前景实例分割得到逐像素蒙版；脚本只负责分割，
// 后续颜色去污染由 Python 根据已知色键背景完成，避免把人物边缘染成洋红色。
guard CommandLine.arguments.count == 3 else {
    FileHandle.standardError.write(Data("usage: extract_foreground_mask.swift <input-image> <output-mask>\n".utf8))
    exit(2)
}

let inputURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outputURL = URL(fileURLWithPath: CommandLine.arguments[2])

guard
    let source = NSImage(contentsOf: inputURL),
    let cgImage = source.cgImage(forProposedRect: nil, context: nil, hints: nil)
else {
    FileHandle.standardError.write(Data("cannot decode input image\n".utf8))
    exit(3)
}

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
let request = VNGenerateForegroundInstanceMaskRequest()
try handler.perform([request])

guard let observation = request.results?.first else {
    FileHandle.standardError.write(Data("Vision found no foreground instance\n".utf8))
    exit(4)
}

let maskBuffer = try observation.generateScaledMaskForImage(
    forInstances: observation.allInstances,
    from: handler
)
let maskImage = CIImage(cvPixelBuffer: maskBuffer)
let context = CIContext(options: [.useSoftwareRenderer: false])
let colorSpace = CGColorSpaceCreateDeviceGray()
try context.writePNGRepresentation(
    of: maskImage,
    to: outputURL,
    format: .L8,
    colorSpace: colorSpace
)
