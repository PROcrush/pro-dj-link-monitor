import Foundation
import CoreAudio

func fourCC(_ status: OSStatus) -> String {
    let value = UInt32(bitPattern: status.bigEndian)
    let bytes = [
        UInt8((value >> 24) & 0xff),
        UInt8((value >> 16) & 0xff),
        UInt8((value >> 8) & 0xff),
        UInt8(value & 0xff)
    ]
    let text = String(bytes: bytes, encoding: .macOSRoman) ?? ""
    return text.allSatisfy { !$0.isASCII || $0.isLetter || $0.isNumber || $0.isPunctuation || $0 == " " } ? text : "\(status)"
}

func address(_ selector: AudioObjectPropertySelector, _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
}

func stringProperty(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String {
    var prop = address(selector)
    var value = "" as CFString
    var size = UInt32(MemoryLayout<CFString>.size)
    let status = AudioObjectGetPropertyData(id, &prop, 0, nil, &size, &value)
    return status == noErr ? (value as String) : "status=\(status)"
}

var devicesAddress = address(kAudioHardwarePropertyDevices)
var devicesSize: UInt32 = 0
let sizeStatus = AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &devicesAddress, 0, nil, &devicesSize)
print("devicesSizeStatus=\(sizeStatus) fourCC=\(fourCC(sizeStatus)) size=\(devicesSize)")

if sizeStatus == noErr && devicesSize > 0 {
    let count = Int(devicesSize) / MemoryLayout<AudioObjectID>.size
    var ids = Array(repeating: AudioObjectID(0), count: count)
    var dataSize = devicesSize
    let dataStatus = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &devicesAddress, 0, nil, &dataSize, &ids)
    print("devicesDataStatus=\(dataStatus) fourCC=\(fourCC(dataStatus)) count=\(count) dataSize=\(dataSize)")
    for id in ids {
        print("device id=\(id) name=\(stringProperty(id, kAudioObjectPropertyName)) uid=\(stringProperty(id, kAudioDevicePropertyDeviceUID))")
    }
}

for selector in [
    kAudioHardwarePropertyDefaultInputDevice,
    kAudioHardwarePropertyDefaultOutputDevice,
    kAudioHardwarePropertyDefaultSystemOutputDevice
] {
    var prop = address(selector)
    var id = AudioObjectID(0)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &prop, 0, nil, &size, &id)
    print("default selector=\(selector) status=\(status) fourCC=\(fourCC(status)) id=\(id)")
}
