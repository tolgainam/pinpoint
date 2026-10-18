# Screens waiting for sign-off

Written by npm run screens:update on darwin, 2026-10-18.
Commit these baselines only with the owner's sign-off, then delete this file.

- test/screens/tip.darwin.png: new (first-show tip above the toolbar after the first icon click, arrow on Comment; spec section 2)
- test/screens/popover.darwin.png: changed: size 382x261, baseline 382x229 (new last row "How it works", in every state; spec section 1)
- test/screens/mismatch.darwin.png: new (bridge one minor version ahead: "!" after the pill label, extension-older line above "How it works"; spec section 3)
- test/screens/welcome.darwin.png: new (welcome page at 600px wide, bridge not connected, "Check again", step 3 ticked; spec section 1)

Not written, kept as signed off (the test fails on these two until decided):

- test/screens/toolbar.darwin.png: would change: 808 pixels differ (2.94%). The toolbar's own pixels are identical; the page behind it is offset by 11px because the bar now sits 11px further right. With the toolbar starting hidden it is centred on first show, using the label it has then ("nimbus"), where the signed-off shot was centred at page load on the wider "Connecting" label.
- test/screens/offline.darwin.png: would change: 893 pixels differ (3.27%). Same 11px offset, same cause.
