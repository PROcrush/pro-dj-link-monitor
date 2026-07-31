import Foundation
import CoreAudio

struct DeviceInfo {
    let id: AudioObjectID
    let name: String
    let uid: String
    let inputChannels: UInt32
    let outputChannels: UInt32
}

func propertyAddress(_ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}

func dataSize(_ id: AudioObjectID, _ address: inout AudioObjectPropertyAddress) throws -> UInt32 {
    var size: UInt32 = 0
    let status = AudioObjectGetPropertyDataSize(id, &address, 0, nil, &size)
    if status != noErr { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    return size
}

func stringProperty(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String {
    var address = propertyAddress(selector)
    var value = "" as CFString
    var size = UInt32(MemoryLayout<CFString>.size)
    let status = AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value)
    return status == noErr ? (value as String) : ""
}

func channelCount(_ id: AudioObjectID, scope: AudioObjectPropertyScope) -> UInt32 {
    var address = propertyAddress(kAudioDevicePropertyStreamConfiguration, scope)
    guard let size = try? dataSize(id, &address), size > 0 else { return 0 }
    let bufferList = UnsafeMutablePointer<AudioBufferList>.allocate(capacity: Int(size))
    defer { bufferList.deallocate() }
    var mutableSize = size
    let status = AudioObjectGetPropertyData(id, &address, 0, nil, &mutableSize, bufferList)
    if status != noErr { return 0 }
    return UnsafeMutableAudioBufferListPointer(bufferList).reduce(UInt32(0)) { $0 + $1.mNumberChannels }
}

func devices() throws -> [DeviceInfo] {
    var address = propertyAddress(kAudioHardwarePropertyDevices)
    let size = try dataSize(AudioObjectID(kAudioObjectSystemObject), &address)
    let count = Int(size) / MemoryLayout<AudioObjectID>.size
    var ids = Array(repeating: AudioObjectID(0), count: count)
    var mutableSize = size
    let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &mutableSize, &ids)
    if status != noErr { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    return ids.map {
        DeviceInfo(
            id: $0,
            name: stringProperty($0, kAudioObjectPropertyName),
            uid: stringProperty($0, kAudioDevicePropertyDeviceUID),
            inputChannels: channelCount($0, scope: kAudioDevicePropertyScopeInput),
            outputChannels: channelCount($0, scope: kAudioDevicePropertyScopeOutput)
        )
    }
}

func defaultDevice(_ selector: AudioObjectPropertySelector) throws -> AudioObjectID {
    var address = propertyAddress(selector)
    var id = AudioObjectID(0)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &id)
    if status != noErr { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    return id
}

func setDefaultDevice(_ selector: AudioObjectPropertySelector, id: AudioObjectID) throws {
    var address = propertyAddress(selector)
    var mutableId = id
    let size = UInt32(MemoryLayout<AudioObjectID>.size)
    let status = AudioObjectSetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, size, &mutableId)
    if status != noErr { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
}

func findDevice(named name: String, wantsInput: Bool, wantsOutput: Bool) throws -> DeviceInfo {
    guard let device = try devices().first(where: {
        $0.name.localizedCaseInsensitiveContains(name) &&
        (!wantsInput || $0.inputChannels > 0) &&
        (!wantsOutput || $0.outputChannels > 0)
    }) else {
        throw NSError(domain: "prodjlink-audio", code: 1, userInfo: [NSLocalizedDescriptionKey: "No matching audio device: \(name)"])
    }
    return device
}

func printState() throws {
    let all = try devices()
    let defaultInput = try defaultDevice(kAudioHardwarePropertyDefaultInputDevice)
    let defaultOutput = try defaultDevice(kAudioHardwarePropertyDefaultOutputDevice)
    let defaultSystemOutput = try defaultDevice(kAudioHardwarePropertyDefaultSystemOutputDevice)
    let payload = all.map {
        [
            "id": $0.id,
            "name": $0.name,
            "uid": $0.uid,
            "inputChannels": $0.inputChannels,
            "outputChannels": $0.outputChannels,
            "defaultInput": $0.id == defaultInput,
            "defaultOutput": $0.id == defaultOutput,
            "defaultSystemOutput": $0.id == defaultSystemOutput
        ] as [String : Any]
    }
    let json = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
    print(String(data: json, encoding: .utf8)!)
}

let args = CommandLine.arguments

do {
    if args.count == 1 || args[1] == "list" {
        try printState()
        exit(0)
    }
    guard args.count >= 4, args[1] == "set-default" else {
        throw NSError(domain: "prodjlink-audio", code: 2, userInfo: [NSLocalizedDescriptionKey: "Usage: set-default output NAME"])
    }
    let target = args[2]
    let name = args.dropFirst(3).joined(separator: " ")
    if target == "output" {
        let device = try findDevice(named: name, wantsInput: false, wantsOutput: true)
        try setDefaultDevice(kAudioHardwarePropertyDefaultOutputDevice, id: device.id)
        print("output=\(device.name)")
    } else {
        throw NSError(domain: "prodjlink-audio", code: 3, userInfo: [NSLocalizedDescriptionKey: "Unsupported target: \(target)"])
    }
} catch {
    fputs("\(error.localizedDescription)\n", stderr)
    exit(1)
}
