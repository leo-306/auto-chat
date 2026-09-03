// 出片复验：帧级剪辑点 + 静音段。不依赖 ffmpeg，只用系统自带的 AVFoundation。
// 用法: xcrun swift scripts/verify-video.swift <video.mp4>
import Foundation
import AVFoundation

let path = CommandLine.arguments[1]
let asset = AVURLAsset(url: URL(fileURLWithPath: path))
let duration = CMTimeGetSeconds(asset.duration)

// ---------- 视频：逐帧解码，算相邻帧平均亮度差 ----------
guard let videoTrack = asset.tracks(withMediaType: .video).first else { fatalError("no video track") }
print(String(format: "duration=%.3fs size=%.0fx%.0f fps=%.2f",
             duration, videoTrack.naturalSize.width, videoTrack.naturalSize.height,
             videoTrack.nominalFrameRate))

let videoReader = try AVAssetReader(asset: asset)
let videoOut = AVAssetReaderTrackOutput(
    track: videoTrack,
    outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
videoReader.add(videoOut)
videoReader.startReading()

let step = 16  // 每 16 个像素取一个，够判断硬切，省一个数量级的时间
var previous: [Int32] = []
var diffs: [(time: Double, index: Int, value: Double)] = []
var frameIndex = 0

while let buffer = videoOut.copyNextSampleBuffer() {
    defer { frameIndex += 1 }
    guard let pixels = CMSampleBufferGetImageBuffer(buffer) else { continue }
    let time = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(buffer))
    CVPixelBufferLockBaseAddress(pixels, .readOnly)
    let width = CVPixelBufferGetWidth(pixels)
    let height = CVPixelBufferGetHeight(pixels)
    let bytesPerRow = CVPixelBufferGetBytesPerRow(pixels)
    let base = CVPixelBufferGetBaseAddress(pixels)!.assumingMemoryBound(to: UInt8.self)
    var current: [Int32] = []
    current.reserveCapacity((width / step + 1) * (height / step + 1))
    for y in stride(from: 0, to: height, by: step) {
        let row = base + y * bytesPerRow
        for x in stride(from: 0, to: width, by: step) {
            let p = row + x * 4
            // BGRA -> 亮度近似
            current.append(Int32(p[2]) * 77 + Int32(p[1]) * 150 + Int32(p[0]) * 29)
        }
    }
    CVPixelBufferUnlockBaseAddress(pixels, .readOnly)
    if !previous.isEmpty && previous.count == current.count {
        var sum = 0.0
        for i in 0..<current.count { sum += abs(Double(current[i] - previous[i])) }
        diffs.append((time, frameIndex, sum / Double(current.count) / 256.0))
    }
    previous = current
}

let sorted = diffs.map { $0.value }.sorted()
let median = sorted[sorted.count / 2]
let threshold = max(median * 6, 8.0)
print(String(format: "frames=%d median-diff=%.2f cut-threshold=%.2f", frameIndex, median, threshold))

// 同一个切口可能连着两帧超阈值，只保留每簇里最强的一帧
var cuts: [(time: Double, index: Int, value: Double)] = []
for candidate in diffs where candidate.value > threshold {
    if let last = cuts.last, candidate.time - last.time <= 0.2 {
        if candidate.value > last.value { cuts[cuts.count - 1] = candidate }
    } else {
        cuts.append(candidate)
    }
}
print("--- cuts ---")
for cut in cuts { print(String(format: "  %.3fs (frame %d) diff=%.1f", cut.time, cut.index, cut.value)) }

print("--- shots ---")
var bounds = [0.0] + cuts.map { $0.time } + [duration]
for i in 0..<(bounds.count - 1) {
    print(String(format: "  shot %d: %.2f–%.2fs  (%.2fs)", i + 1, bounds[i], bounds[i + 1], bounds[i + 1] - bounds[i]))
}

// ---------- 音频：0.05s RMS 包络 + 静音段 ----------
guard let audioTrack = asset.tracks(withMediaType: .audio).first else {
    print("no audio track"); exit(0)
}
let audioReader = try AVAssetReader(asset: asset)
let audioOut = AVAssetReaderTrackOutput(track: audioTrack, outputSettings: [
    AVFormatIDKey: kAudioFormatLinearPCM,
    AVLinearPCMBitDepthKey: 16,
    AVLinearPCMIsFloatKey: false,
    AVLinearPCMIsBigEndianKey: false,
    AVLinearPCMIsNonInterleaved: false,
    AVNumberOfChannelsKey: 1,
    AVSampleRateKey: 16000.0,
])
audioReader.add(audioOut)
audioReader.startReading()

var samples: [Int16] = []
while let buffer = audioOut.copyNextSampleBuffer() {
    guard let block = CMSampleBufferGetDataBuffer(buffer) else { continue }
    let length = CMBlockBufferGetDataLength(block)
    var bytes = [UInt8](repeating: 0, count: length)
    CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: &bytes)
    bytes.withUnsafeBytes { raw in samples.append(contentsOf: raw.bindMemory(to: Int16.self)) }
}

let rate = 16000, window = 800  // 0.05s
var envelope: [(Double, Double)] = []
var cursor = 0
while cursor + window <= samples.count {
    var sum = 0.0
    for i in cursor..<(cursor + window) {
        let v = Double(samples[i]) / 32768.0
        sum += v * v
    }
    let rms = (sum / Double(window)).squareRoot()
    envelope.append((Double(cursor) / Double(rate), rms > 0 ? 20 * log10(rms) : -120))
    cursor += window
}
let levels = envelope.map { $0.1 }.sorted()
let bed = levels[levels.count / 2]
let peak = envelope.max { $0.1 < $1.1 }!
print(String(format: "--- audio: bed(median)=%.1fdB peak=%.1fdB at %.2fs ---", bed, peak.1, peak.0))

// 相对底噪 -6dB 以下、持续 >=0.15s 算一个静音段
let quietLine = bed - 6
var runStart: Double? = nil
print(String(format: "--- silence (< %.1fdB for >= 0.15s) ---", quietLine))
for (t, db) in envelope {
    if db < quietLine {
        if runStart == nil { runStart = t }
    } else if let start = runStart {
        if t - start >= 0.15 { print(String(format: "  %.2f–%.2fs (%.2fs)", start, t, t - start)) }
        runStart = nil
    }
}
if let start = runStart, envelope.last!.0 - start >= 0.15 {
    print(String(format: "  %.2f–%.2fs (%.2fs, 到片尾)", start, envelope.last!.0, envelope.last!.0 - start))
}
// 全片最强的几个瞬态：对上「咔」「笑」这类点状声音设计
print("--- transients (top 6 local maxima) ---")
var peaks: [(Double, Double)] = []
for i in 1..<(envelope.count - 1) where envelope[i].1 > envelope[i-1].1 && envelope[i].1 >= envelope[i+1].1 {
    peaks.append(envelope[i])
}
for p in peaks.sorted(by: { $0.1 > $1.1 }).prefix(6).sorted(by: { $0.0 < $1.0 }) {
    print(String(format: "  %.2fs %.1fdB (bed+%.0f)", p.0, p.1, p.1 - bed))
}
