// The D-Bus contract between the extension (service) and the app (client).
// The service name differs from the app id (io.github.fafafa12.TimeTracker),
// which GApplication already owns on the session bus.

export const BUS_NAME = 'io.github.fafafa12.TimeTrackerService';
export const OBJECT_PATH = '/io/github/fafafa12/TimeTrackerService';

export const INTERFACE_XML = `
<node>
  <interface name="io.github.fafafa12.TimeTrackerService">
    <method name="GetToday"><arg type="s" direction="out" name="json"/></method>
    <method name="StartBreak"/>
    <method name="FinishBreak"/>
    <method name="SetArrival"><arg type="s" direction="in" name="time"/></method>
    <method name="ResetArrival"/>
    <method name="SaveDay"><arg type="s" direction="in" name="date"/><arg type="s" direction="in" name="day"/></method>
    <method name="DeleteDay"><arg type="s" direction="in" name="date"/></method>
    <signal name="Changed"><arg type="s" name="date"/></signal>
  </interface>
</node>`;

export const INVALID_ARGS = 'org.freedesktop.DBus.Error.InvalidArgs';
export const FAILED = 'org.freedesktop.DBus.Error.Failed';
