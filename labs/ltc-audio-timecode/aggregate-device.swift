import Foundation
import CoreAudio

let aggregateName = "PRO DJ LINK LTC Aggregate"
let aggregateUID = "local.prodjlink.ltc.aggregate"

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

func getPropertyDataSize(_ id: AudioObjectID, _ address: inout AudioObjectPropertyAddress) throws -> UInt32 {
    var size: UInt32 = 0
    let status = AudioObjectGetPropertyDataSize(id, &address, 0, nil, &size)
    if status != noErr { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    return size
}

func getStringProperty(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String {
    var address = propertyAddress(selector)
    var value = "" as CFString
    var size = UInt32(MemoryLayout<CFString>.size)
    let status = AudioObjectGetPropertyData(id, &address, 0, nil, &size, &value)
    return status == noErr ? (value as String) : ""
}

func channelCount(_ id: AudioObjectID, scope: AudioObjectPropertyScope) -> UInt32 {
    var address = propertyAddress(kAudioDevicePropertyStreamConfiguration, scope)
    guard let size = try? getPropertyDataSize(id, &address), size > 0 else { return 0 }
    let bufferList = UnsafeMutablePointer<AudioBufferList>.allocate(capacity: Int(size))
    defer { bufferList.deallocate() }
    var dataSize = size
    let status = AudioObjectGetPropertyData(id, &address, 0, nil, &dataSize, bufferList)
    if status != noErr { return 0 }
    let buffers = UnsafeMutableAudioBufferListPointer(bufferList)
    return buffers.reduce(UInt32(0)) { $0 + $1.mNumberChannels }
}

func devices() throws -> [DeviceInfo] {
    var address = propertyAddress(kAudioHardwarePropertyDevices)
    let size = try getPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address)
    let count = Int(size) / MemoryLayout<AudioObjectID>.size
    var ids = Array(repeating: AudioObjectID(0), count: count)
    var dataSize = size
    let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &dataSize, &ids)
    if status != noErr { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    return ids.map {
        DeviceInfo(
            id: $0,
            name: getStringProperty($0, kAudioObjectPropertyName),
            uid: getStringProperty($0, kAudioDevicePropertyDeviceUID),
            inputChannels: channelCount($0, scope: kAudioDevicePropertyScopeInput),
            outputChannels: channelCount($0, scope: kAudioDevicePropertyScopeOutput)
        )
    }
}

func findDevice(matching text: String) throws -> DeviceInfo {
    guard let device = try devices().first(where: {
        ($0.name.localizedCaseInsensitiveContains(text) || $0.uid.localizedCaseInsensitiveContains(text)) &&
        $0.inputChannels > 0 &&
        $0.outputChannels > 0
    }) else {
        throw NSError(domain: "prodjlink-aggregate", code: 1, userInfo: [NSLocalizedDescriptionKey: "No matching bidirectional device: \(text)"])
    }
    return device
}

func findDevice(uid: String) throws -> DeviceInfo? {
    try devices().first { $0.uid == uid }
}

func destroyExistingAggregate() throws {
    if let existing = try findDevice(uid: aggregateUID) {
        let status = AudioHardwareDestroyAggregateDevice(existing.id)
        if status != noErr { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
        print("destroyed=\(existing.name)")
    }
}

func createAggregate(sourceName: String) throws {
    let source = try findDevice(matching: sourceName)
    try destroyExistingAggregate()
    let subDevice: [String: Any] = [
        kAudioSubDeviceUIDKey as String: source.uid
    ]
    let aggregateDescription: [String: Any] = [
        kAudioAggregateDeviceNameKey as String: aggregateName,
        kAudioAggregateDeviceUIDKey as String: aggregateUID,
        kAudioAggregateDeviceSubDeviceListKey as String: [subDevice],
        kAudioAggregateDeviceMasterSubDeviceKey as String: source.uid,
        kAudioAggregateDeviceIsPrivateKey as String: false
    ]
    var aggregateID = AudioObjectID(0)
    let status = AudioHardwareCreateAggregateDevice(aggregateDescription as CFDictionary, &aggregateID)
    if status != noErr { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    print("created=\(aggregateName) source=\(source.name)")
}

func printState() throws {
    let payload = try devices().map {
        [
            "id": $0.id,
            "name": $0.name,
            "uid": $0.uid,
            "inputChannels": $0.inputChannels,
            "outputChannels": $0.outputChannels
        ] as [String : Any]
    }
    let json = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
    print(String(data: json, encoding: .utf8)!)
}

let args = CommandLine.arguments

do {
    if args.count == 1 || args[1] == "list" {
        try printState()
    } else if args[1] == "create" {
        guard args.count >= 3 else {
            throw NSError(domain: "prodjlink-aggregate", code: 2, userInfo: [NSLocalizedDescriptionKey: "Usage: create SOURCE_NAME"])
        }
        let source = args.dropFirst(2).joined(separator: " ")
        try createAggregate(sourceName: source)
    } else if args[1] == "destroy" {
        try destroyExistingAggregate()
    } else {
        throw NSError(domain: "prodjlink-aggregate", code: 2, userInfo: [NSLocalizedDescriptionKey: "Usage: list | create SOURCE_NAME | destroy"])
    }
} catch {
    fputs("\(error.localizedDescription)\n", stderr)
    exit(1)
}
