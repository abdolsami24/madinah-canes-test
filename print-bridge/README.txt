Madinah Market — Kitchen Print Bridge
=====================================

WHAT THIS IS
The website runs in the cloud and cannot see the printers in the
restaurant. This small program runs on the kitchen computer: it finds
the printers there, tells the website about them, and then prints
each paid order's ticket by itself — no browser page needs to stay
open. Staff pick the ticket printer in Admin -> Operations ->
Kitchen printer.

SETUP (one time)
1. If Node.js is not installed on the kitchen computer, install the
   LTS version from https://nodejs.org (free, a few clicks), then
   come back here.
2. Extract this folder anywhere, for example on the Desktop.
3. On the website, go to Admin -> Operations -> Kitchen printer and
   press "Generate pairing code". A 6-digit code appears (it is good
   for 15 minutes).
4. Double-click start-bridge.bat in this folder. The first time, it
   asks for the website address (just press Enter for the normal
   address) and the pairing code. Type the code and press Enter.
   The bridge saves its pairing in bridge-config.json next to the
   script — you only do this once.
5. Back in Admin -> Operations -> Kitchen printer, the status turns
   green ("Connected") and your printers appear. Click the printer
   that should print order tickets, choose the number of copies,
   and press "Test print". A test ticket should come out within a
   few seconds.
6. Optional: run install-autostart.bat once. It puts a shortcut in
   the Windows Startup folder so the bridge starts by itself every
   time the computer starts.

EVERYDAY USE
Just leave the bridge window open (you can minimize it). Paid orders
print on their own. If the computer or the bridge is off, nothing is
lost: orders still appear on the kitchen page, the TV board and
Fresh KDS, and the bridge prints any order it missed once it is
running again — each order exactly once.

TROUBLESHOOTING
- "Website rejected this bridge's token": the pairing was revoked
  in Admin. Close the bridge, delete bridge-config.json, run
  start-bridge.bat again and pair with a fresh code.
- A ticket failed 3 times (paper out, printer off): the bridge
  stops retrying that one ticket and Admin shows the error. Fix the
  printer and press "Test print" — new orders keep printing.
- Changed the printer? Pick the new one in Admin — no restart of
  the bridge needed. "Search again" makes the bridge re-scan the
  printers right away.

FILES
bridge.js             the program (Node.js, no add-ons needed)
start-bridge.bat      double-click to run the bridge
install-autostart.bat run once to start the bridge with Windows
bridge-config.json    created at pairing (site address + token) —
                      do not send this file to anyone; the token is
                      the bridge's password.
