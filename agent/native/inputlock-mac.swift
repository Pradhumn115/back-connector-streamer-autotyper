// bcsa-inputlock-mac: blocks *physical* keyboard/mouse input on macOS while
// letting *synthetic* (injected) events through, so a remote client can still
// control the machine. Installs a CGEventTap that suppresses events whose source
// is the hardware HID system; injected events (from nut-js / CGEventPost) report
// a different source state and pass through.
//
// The tap exists only while this process runs — killing it (or a crash) removes
// the tap and instantly restores input. That is the primary safety failsafe.
//
// Requires Accessibility permission (same as nut-js). Exits non-zero if the tap
// can't be created so the caller can report the feature as unavailable.
//
// Prints "READY" on stdout once the tap is active.

import CoreGraphics
import CoreVideo
import Foundation

// `bcsa-inputlock-mac refresh` prints the main display's refresh rate (Hz) and
// exits — used by the agent to auto-target the streaming frame rate. Uses
// CVDisplayLink, which reports the true rate even for built-in Apple displays
// (CGDisplayModeGetRefreshRate returns 0 for those).
if CommandLine.arguments.contains("refresh") {
  var link: CVDisplayLink?
  CVDisplayLinkCreateWithCGDisplay(CGMainDisplayID(), &link)
  if let link = link {
    let period = CVDisplayLinkGetNominalOutputVideoRefreshPeriod(link)
    let indefinite = (period.flags & CVTimeFlags.isIndefinite.rawValue) != 0
    if !indefinite, period.timeValue != 0 {
      let hz = Double(period.timeScale) / Double(period.timeValue)
      print(Int(hz.rounded()))
      exit(0)
    }
  }
  exit(1) // couldn't determine; caller falls back
}

let eventMask: CGEventMask =
    (1 << CGEventType.keyDown.rawValue) |
    (1 << CGEventType.keyUp.rawValue) |
    (1 << CGEventType.flagsChanged.rawValue) |
    (1 << CGEventType.leftMouseDown.rawValue) |
    (1 << CGEventType.leftMouseUp.rawValue) |
    (1 << CGEventType.rightMouseDown.rawValue) |
    (1 << CGEventType.rightMouseUp.rawValue) |
    (1 << CGEventType.otherMouseDown.rawValue) |
    (1 << CGEventType.otherMouseUp.rawValue) |
    (1 << CGEventType.mouseMoved.rawValue) |
    (1 << CGEventType.leftMouseDragged.rawValue) |
    (1 << CGEventType.rightMouseDragged.rawValue) |
    (1 << CGEventType.otherMouseDragged.rawValue) |
    (1 << CGEventType.scrollWheel.rawValue)

let hidSystemState = Int64(CGEventSourceStateID.hidSystemState.rawValue)

let callback: CGEventTapCallBack = { proxy, type, event, _ in
    // The system disables a tap if the callback is too slow or on user input;
    // re-enable it and pass the event along.
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let tap = sharedTap { CGEvent.tapEnable(tap: tap, enable: true) }
        return Unmanaged.passUnretained(event)
    }
    // Suppress only real hardware events; let injected events through.
    let stateID = event.getIntegerValueField(.eventSourceStateID)
    if stateID == hidSystemState {
        return nil
    }
    return Unmanaged.passUnretained(event)
}

var sharedTap: CFMachPort?

guard
    let tap = CGEvent.tapCreate(
        tap: .cgSessionEventTap,
        place: .headInsertEventTap,
        options: .defaultTap,
        eventsOfInterest: eventMask,
        callback: callback,
        userInfo: nil
    )
else {
    FileHandle.standardError.write(
        Data("failed to create event tap (Accessibility permission required)\n".utf8))
    exit(2)
}
sharedTap = tap

let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)

FileHandle.standardOutput.write(Data("READY\n".utf8))
CFRunLoopRun()
