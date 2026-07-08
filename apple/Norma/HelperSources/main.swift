import Foundation

// NormaHelper entry point. A privileged (SMAppService.daemon) XPC service — no UI, no run loop
// work beyond servicing the com.norma.helper mach service.
let delegate = HelperServiceDelegate()
let listener = NSXPCListener(machServiceName: normaHelperMachServiceName)
listener.delegate = delegate
listener.resume()
RunLoop.current.run()
