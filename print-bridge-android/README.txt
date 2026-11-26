MADINAH MARKET — KITCHEN PRINT BRIDGE FOR THE ANDROID TABLET
=============================================================

This makes your website print order tickets by itself on the Star
printer in the kitchen, using the Android tablet that is already
there. You control everything from your own Admin panel
(Admin -> Operations -> Kitchen printer): pairing, the printer,
Test print, and the on/off switch.

Follow the steps in order. It takes about 15 minutes.

---------------------------------------------------------------
STEP 1 — Install Termux and Termux:Boot (from F-Droid)
---------------------------------------------------------------
The Play Store version of Termux is old and does not work well.
Install both apps from F-Droid instead:

  Termux:      https://f-droid.org/packages/com.termux/
  Termux:Boot: https://f-droid.org/packages/com.termux.boot/

(If F-Droid itself is not on the tablet yet, its page will offer
the F-Droid app first — install that, then the two apps above.)

After installing, open Termux once and wait until you see a black
screen with text and a $ sign. Then you can go to the next step.

---------------------------------------------------------------
STEP 2 — Let Termux use the battery freely
---------------------------------------------------------------
Android likes to put apps to sleep. The bridge must stay awake:

  Settings -> Apps -> Termux -> Battery -> choose "Unrestricted"

(Exact words differ a little between tablets; look for Battery
inside the Termux app info page.)

---------------------------------------------------------------
STEP 3 — Put the bridge files on the tablet
---------------------------------------------------------------
Download the file madinah-print-bridge-android.zip on this tablet
(it lands in the Downloads folder).

Then open Termux and paste these commands, one block at a time.
Press Enter after each block and allow any permission it asks for:

    termux-setup-storage

    pkg update -y && pkg install -y unzip

    unzip ~/storage/downloads/madinah-print-bridge-android.zip -d ~/madinah-bridge

The first command asks Android for permission to see your files —
tap Allow.

---------------------------------------------------------------
STEP 4 — Run the setup and pair the tablet
---------------------------------------------------------------
In Termux, paste:

    cd ~/madinah-bridge && bash setup.sh

Setup installs Node.js (a few minutes the first time), sets up
auto-start, and starts the bridge. The bridge asks a few questions:

  * Website address — just press Enter (the address is filled in).
  * Tablet name — just press Enter ("kitchen-tablet" is fine).
  * Pairing code — on your computer/phone open the website Admin
    -> Operations -> Kitchen printer -> "Generate pairing code",
    and type the 6-digit code on the tablet.
  * Printer IP — the bridge searches the network and fills in the
    Star printer's address it found. If the address looks right,
    just press Enter.

When it says the bridge is running, pairing is done. Keep the
Termux window open.

---------------------------------------------------------------
STEP 5 — Choose the printer in Admin and test
---------------------------------------------------------------
On your computer/phone, in Admin -> Operations -> Kitchen
printer, you should now see:

  * "Connected" with the tablet name, and
  * the printer "STAR TSP143" in the printer list.

Select the STAR printer, then press "Test print". A test ticket
should come out of the Star printer. After that, real paid orders
print by themselves.

---------------------------------------------------------------
GOOD TO KNOW
---------------------------------------------------------------
* Keep the tablet plugged in and connected to the restaurant
  Wi-Fi. If the tablet is off or on another network, orders wait
  safely on the website and print when it comes back.
* Fresh KDS is not touched by this. It keeps working exactly as
  before, on the same tablet.
* Pairing this tablet REPLACES the laptop bridge. The laptop
  bridge will stop working — that is expected and fine; it is no
  longer needed.
* If the tablet restarts (power cut, update), the bridge starts
  again by itself after about a minute, thanks to Termux:Boot.
  Just make sure Termux:Boot was opened once after installing it.
* If the printer's network address changes, the bridge searches
  the network again by itself and keeps printing.
* To stop the bridge: open Termux and press Ctrl + C (in Termux,
  Volume Down + C works as Ctrl + C). To start it again:
      cd ~/madinah-bridge && ./start-bridge.sh
