<!-- source: https://resources.arc.net/hc/en-us/articles/20498377604887 ; retrieved 2026-11-08 via web_extract (live Help Center pruned after Arc sunset) -->

# Arc for macOS - 2023 Release Notes

## December 14, 2023 —

**V1.21.0**

- You can now flip Split View orientation (top to bottom vs left to right) through the Split Controls button at the top of your split panel.
- Toolbar has improved truncation logic for Full URLs and some additional UI fixes and improvements.
- We've fixed a bug that prevented Copy / Paste of images into Easel.
- Reader mode styling has been updated. Reader mode is in beta and can be entered / exited via View > Enter Reader Mode.
- We've fixed a bug where you couldn't shared quotes containing an @ symbol.
- Easel and note favicons are now correct in the Archive.
- We've fixed a crash in Arc Notes caused by creating sublists.
- We've fixed the Share Easel popover during window resizing.
- We've fixed a regression in for Sharing Split View by right-clicking on a Split Tab.
- We've tweaked the Easel "Copy Link" text to accommodate dark mode.
- We've improved Easel performance while moving a lot of content at once.
- [Easel release notes](https://arc.net/e/6433CE8D-2D3F-4FF2-AD51-6EF0CBAD197F)

## December 7, 2023 —

**V1.20.0**

- You can now opt in to show the Full URL in Toolbar. Start by turning on Toolbar in View > Show Toolbar. Then right-click on Toolbar to "Show Full URL".
- We've also made improvements to the Toolbar layout generally to support the new Full URLs and improvements to display in Split View.
- Window resizing is now a whole lot smoother.
- We've improved how the Toolbar applies page color when quickly turning it on and off.
- We've added a persistent Capture button to your Easels in the Sidebar to allow you to quickly collect anything you find across the internet.
- Hitting ESC will now exit Peek for Easels.
- You can now quickly make pretty screenshots of tabs in Portrait Mode. Click the screenshot button in the toolbar (when in Developer Mode) or use CMD T... "Capture in Portrait Mode" to try it out.
- Entering Developer Mode now automatically installs the JSON Formatter extension for an easier reading experience.
- We've made a bunch of small but mighty pixel tweaks to tab spacing.
- Downloads in Little Arc now have rename prompts when Arc Max Tidy Downloads is turned on.
- Moving tabs from one Space to another no longer triggers the rename input field.
- We found and fixed more cases where custom space-switching shortcuts would be reset.
- Performance update: we've improved the speed of loading tab favicons in the Command Bar.
- We've fixed an issue that prevented extension windows from displaying correctly in Incognito windows.
- [Easel release notes](https://arc.net/e/D25B2EEA-7506-4850-A169-3B2A00802889)

## November 30, 2023 —

**V1.19.1**

- Pinned Extensions are now live in the URL Bar! Head to the Site Settings Button in the URL bar and click the Pin icon on any extension you want easily accessible. Hover over the URL Bar to access any pinned extensions.
- Introducing Tab Handoff! Arc keeps your place on each tab regardless of which window you're using. This is a game-changer, especially for forms, scrolled pages, and videos. This means only one instance of each tab will load, even across multiple windows.
- Arc Max's ChatGPT Command Bar integration is even faster. If you have it enabled, you'll now see it as a suggestion when typing queries.
- Highlighting text on any webpage now exposes a "Share Quote" option in the URL bar and right-click menu. Clicking now creates and copies a custom hyperlink to your webpage, with an image that features the quote. Send this via iMessage or Twitter!
- Little Arc Windows now auto-archive every 6 hours by default. You can edit this setting in Arc > Settings > General. You can view all archived tabs by hitting CMD T and typing "View Archive". Filter for Little Arc.
- Right-clicking on the Arc Icon in the Mac Dock provides an option to "Show/Hide All Little Arc Windows".
- We've made fixes to the tab scroll speed and "overflow indicator" when navigating to a tab that's no longer in view in the sidebar.
- Easily create a new split by hitting CMD T and typing "Add Right Split", "Add Left Split", "Add Top Split", or "Add Bottom Split".
- The Library will now automatically open to the last-used section. For example, after downloading, the Downloads section will be selected first upon opening the Library.
- Restoring tabs from the Archive now automatically routes back to the Space they came from.
- Text fields in Easels now have spell check enabled by default.
- The Space Viewer in the Library now allows dragging/dropping tabs into empty Spaces.
- It's now possible to mute a tab in Split View by right-clicking on the split and selecting "Mute" under the tab's name. It's also now possible to duplicate a split in the tab's right-click menu.
- Adding Shared Folders to your sidebar will now always insert at the bottom of your Pinned Tabs section.
- We've fixed the formatting of text on Easel link cards.
- Site Search on X (formerly Twitter) now uses the new X branding and name.
- Right-click on a shortcut in Arc > Settings to more easily "Reset Shortcut to Default".
- Enabling and Disabling Previews can now be done in the Site Settings button in the URL Bar.
- The "Back to PiP" button from the Mini Audio Player now animates while heading to the proper location.
- We've fixed a long-standing bug where hitting the Share button on an Easel in Peek didn't work.
- We fixed the issue causing custom space-switching shortcuts to be reset on restart of Arc.
- We've fixed a bug where downloads were defaulting to the "last saved location" as the destination, despite selecting a specific folder in preferences.
- We've fixed a bug where Arc Max Tidy Downloads were incorrectly renaming files.
- Performance improvement: We've fixed a potential performance issue that could arise from leaving the Preferences window open in the background.
- Performance improvement: each Little Arc window will perform fewer per-profile actions when first opening.
- Arc v1.19.1 contains an important security fix for a Chromium vulnerability. We strongly recommend updating to Arc v1.19.1 as soon as you can, as it is based on Chromium 119.0.6045.199, which contains this fix. Update and stay safe out there!

##

## November 17, 2023 —

**V1.17.2**

- Introducing Folder Icons! You can now select or edit a Folder Icon by right-clicking on a Folder and selecting "Change Icon".
- It's simpler to view and cancel in-progress Downloads. Find Download size, time left, and a cancel button at the bottom of your Sidebar.
- Arc Max, a set of AI power-ups inside Arc, can now be enabled during Arc onboarding.
- Option + Clicking on a Split View Tab in the Sidebar now quickly separates the Split View into two tabs.
- We've improved the tab clearing animation when hitting "Clear" (cmd + shift + k) above your Unpinned Tabs.
- Restored tabs from Archive now follow Air Traffic Control Routes. You can create a new Route via Arc > Settings > Links > Air Traffic Control.
- We've fixed a bug with Korean input inside the CMD F menu.
- Arc's horizontal Space swipe animation now includes an icon transition animation.
- We've added a confirmation dialogue to"Clear Archive". You can Clear Archive via Archive > Clear Archive in the Mac Menu Bar.
- Shared Spaces / Folder tabs you've received now have favicons.
- 5-Second-Preview images now match the OpenGraph image aspect ratio.
- We've fixed a bug where Arc was not detecting system locale correctly and defaulting to en-US in some cases.
- We've fixed a bug where "Ask every time" was forgetting your most recent download location.
- Performance improvements: We've eliminated unnecessary background processing upon exiting the command bar. We've addressed a performance glitch triggered by copying large amounts of text.

##

## November 2, 2023 —

**V1.15.0**

- Split View now shows the URL of each panel in the Toolbar for ease of editing each panel's URL.
- You can now create a new Split from the plus button at the bottom of the Sidebar. We've removed the previous entry point for Split View on the right hand border of Arc.
- If you click the same link within an external app, we'll simply resurface the existing Little Arc window instead of creating a duplicate one.
- Little Arc will now remember the profile you select for a given domain. New links within that domain will have the profile automatically selected.
- ESC will now reliably default to "Prefer Websites" rather than exit fullscreen. Hold (or double hit) ESC to exit fullscreen instead.
- View Advanced Chromium Settings by clicking the "Advanced Settings" button in Arc > Settings > Advanced.
- After searching in CMD F, we'll make it more clear when you have no matches before prompting you to try the Arc Max Ask feature.
- We've fixed a bug where Arc was not detecting system locale correctly and defaulting to en-US in some cases.
- We've fixed a bug where Favorited Split Tabs were not focused correctly after Space switching.
- For consistency, new windows will now always open with the command bar in it's center location.
- We've fixed a bug that could cause the Google Calendar preview to log out when opening a tab in Split View.
- You can now use Confluence as a default note type to create a Confluence page
- We have improved the performance and the stability of the video decoding pipeline.
- Staged Rollout (we are monitoring release of this feature over the coming week): We've added YouTube to the trusted sites list for uBlock Origin (our default ad blocker) so Members can watch YouTube videos without encountering the "Ad blockers violate YouTube's Terms of Service" notice. You can enable ad blocking on YouTube in the extension settings for uBlock Origin at any time, just keep in mind that you may encounter YouTube's ad blocking notice and be unable to watch videos if you do so.

##

## October 26, 2023 —

**V1.14.0**

- Introducing [Shared Collections](https://resources.arc.net/en/articles/8513994-share-spaces-folders-splits-with-anyone)! You can now share perma-links to Spaces, Folders, Split Views, and selected tabs to anyone, on any browser. Right click on any Folder, Split View, or selected tab group in your sidebar and click the "Share" option. To share Spaces, hover over your Space title and click "Share". Anyone, with any browser, can view the link. Arc members can add the Shared Collection to their sidebar.
- Choose a default Notes App! Head to Arc > Settings > General to select between Arc -Notes, Google Docs, Notion, or Word Docs. Hit CMD T … New Note or go to the plus button at the bottom of the sidebar to open a note in your preferred App.
- We've fixed a long standing bug in the Command Bar where the last character was dropped while typing in Korean and a couple other languages.
- Arc Max features will now respond your preferred language.
- The Mini Player now has a new layout, including an affordance to move seamlessly to Picture-in-Picture for video content.
- We've fixed a bug that broke how ESC exits full screen when "Prefer Websites" was selected in Preferences.
- When PiP windows are selected, you can now seek / skip via left / right arrow keys, and play / pause via spacebar.
- "Archive Below" in the Right Click Menu for Tabs is now available for Split View.
- We've improved the UX of Arc Max Ask on Page for multiple queries.
- The location to Edit Legacy Boosts has been moved to Extensions > Edit Legacy Boosts in the Mac Menu Bar.
- When closing a completely empty Arc Note, we now delete it fully instead storing it in the Archive.
- We've fixed an issue that caused text cursors within websites to disappear.
- We've fixed an issue that could sometimes cause signing into the Google Calendar preview to fail.

##

## October 19, 2023 —

**V1.13.0**

- Instantly find your last tab with the new Recent Tab Indicator! You'll see a slight highlight on your last tab's favicon so you can jump to it quickly. You can also hit CTRL Tab to jump to your last tab anytime without looking.
- When a 5-Second Preview loads, a share button will appear. From there, you can copy the summary card as text (including the link) or as an image.
- If you have a URL in your clipboard, Paste and Go is now a top option in the command bar or when hovering over the new tab button with CMD held.
- Dragging and dropping tabs in Arc is now simpler and snappier.
- We fixed a bug where google meet video would sometimes not show in PiP!
- "gpt" is now an alias for searching ChatGPT in the Command Bar. Type either and then hit "Tab"!
- We no longer push you into renaming when you pin a Split View tab.
- We fixed an issue that caused tabs to crash on some sites, particularly Google Cloud Console.

##

## October 12, 2023 —

**V1.12.0**

- You can now have multiple Little Arc windows open at once! You'll also notice improvements to design and Little Arc opening animations.
- The Sidebar will now dim slightly when the Arc Window is not in focus.
- We've improved the UX of dragging a tab out of the sidebar, preventing accidental new windows.
- We've implemented Chromium's Sad Tab feature, which shows when tabs aren't rendered correctly. If you see this, hit CMD SHIFT R or close the tab.
- Command + Option + Delete now deletes a selected suggestion in CMD T.
- We fixed a bug with Max 5-Second Preview that may have caused the preview to trigger on the wrong window.
- We've made fixes to some common renderer crashes, which should prevent "blank" tabs.
- We fixed a bug where the Mini Audio Player wouldn't show when the audio volume was very low.

##

## October 5, 2023 —

**V1.11.0**

- Introducing [Arc Max](https://resources.arc.net/en/articles/8399405-arc-max), an experimental suite of AI features! To view and turn on Max features, head to Arc > Settings > Max.
- Arc will now freeze tabs that are excessively consuming CPU while in the background.
- We've fixed a bug around auth redirects on sites like Jira.
- ESC now Prefers Website by default to prevent accidental Full Screen exiting. You can remap this shortcut in Arc > Settings > Shortcuts.
- We've added logic to ensure Little Arc opens in the correct macOS space.
- Undocked Dev Tools will now be brought into focus correctly with a shortcut, defaulted to CMD OPT I.
- If an extension causes Arc to crash we'll automatically disable that extension and show you a dialog with the heads up.

##

## September 28, 2023 —

**V1.10.1**

- Speed around the internet with Arc's Essential Shortcuts! Find them in Help > Essential Keyboard Shortcuts.
- Arc has your back with Battery Saver Mode! When your device has < 20% battery, you'll get a heads up when Battery Saver Mode is activated. It will turn off automatically once battery is back over 20%.
- The Arc Toolbar (View > Show Toolbar) will now show translation prompts on sites not in your primary language.
- Images from Clipboard can now be pasted into Arc notes!
- You can now toggle Developer Mode on subdomains of localhost from the Site Control Center.
- ESC or double clicking the reload icon will stop reloading the page.
- We've simplified enter / exit fullscreen animations in order to improve performance.
- We've fixed favicon loading issues in the back button / forward button long press menus.
- Selecting tabs within a folder (shift click) then right clicking allows you to create a new, nested folder.

##

## September 21, 2023 —

**V1.9.1**

- Improved speed for switching spaces when top bar is enabled.
- We now have a global preference to turn off Picture-in-Picture in Arc > Settings > Advanced.
- We've improved the UI of Previews. To learn more or turn previews on / off head to Arc > Settings > General.
- [We've fixed three bugs in Sonoma](https://resources.arc.net/en/articles/8257976-known-issues-macos-sonoma): an issue with clicking into the Library, a bug with Space swiping with the sidebar hidden, and a crash caused by changing your Space icon.
- You can now hit FN+F to toggle window fullscreen.
- Favorited tabs in Developer Mode will now also have Developer Mode styling.
- You can now right click on the URL Bar to show or hide the Toolbar.
- It's now possible to remap the Exit Full Screen priority. You can edit shortcuts in Arc > Settings > Shortcuts.
- Dragging text into the sidebar will create a new search tab using your default search engine.
- Hitting CMD T and then "Share" will now open the share-sheet to share your current tab.
- Site Search will now be enabled across all profiles when activating via a toast suggestion.
- We've improved the progress bar for livestream videos in Picture-in-Picture.
- You can cast your current tab using View > Cast in the Mac Menu Bar.

##

## September 14, 2023 —

**V1.8.0**

- For new Arc members, we're automatically suggesting Favorites and Pinned Tabs based on imported navigation history.
- Clicking on web notifications now brings you to the notifying tab more reliably.
- We've fixed an issue where Little Arc didn't properly open when Arc was in Fullscreen.
- The shortcut for a new Note is now CTRL+SHIFT+N. You can change this in Arc > Settings > Shortcuts.
- Arc v1.8.0 contains an important security fix for a Chromium vulnerability. We strongly recommend updating to Arc v1.8.0 as soon as you can, as it is based on Chromium v116.0.5845.187, which contains this fix. Update and stay safe out there!

##

## September 7, 2023 —

**V1.7.0**

- Check out our quick guide to Arc! Hit CMD T and type "Getting Started".
- We've changed the look and feel of our Account Creation and Sign In Flow.
- We've made early fixes to issues getting out of Full Screen. Thanks to all who've reported!
- Hitting ESC will now close the "Translate" popup in the sidebar.
- We've fixed an issue that causes Extensions to unpin.
- We've fixed a bug that caused occasional freezing when changing a Space Icon.
- Closing a previewed item in Archive with CMD+W now works correctly.
- Exporting Easels in Dark Mode is now dark mode aware.
- The "What's New" banner now includes an indication for videos!
- We now select the first item in the list when you start typing in the Folder Preview.
- We have our own styled verification emails when resetting your Arc email.

##

## August 31, 2023 —

**V1.6.0**

- Forward / Back 15 seconds in Mini Video Player (PiP) now works reliably.
- We fixed a bug which prohibited you from logging into multiple accounts on the calendar preview. To add one, click the gear!
- You can now create a new Split from the currently selected tab (previously disabled).
- You can now open extensions in Incognito Mode with shortcuts. This requires that you've enable the extension in Incognito.
- We've fixed a bug in Arc Notes that made it difficult to reformat text.
- You can now right click on the Toolbar to Copy URL, Take a Capture, or Share the Page.
- We've made improvements to Toolbar performance and color selection.
- We fixed a bug that prevented sharing Easels while in Peek.
- CMD-left-click or middle-click on the back / forward buttons now navigate back/forward in a new tab.
- We've improved the reliability of CMD E. Hold CMD and hit E to toggle through and open pinned extensions.
- Hitting ESC will now exit out of fullscreen and close peek windows.
- The plus and Library icons at the bottom of your sidebar are a bit larger so they're easier to click.
- Opening a new window (CMD N) while in fullscreen will now open that window in fullscreen too.

##

## August 24, 2023 —

**V1.5.0 / 1.5.1**

- Unpinned tabs will now sync across all windows and all devices. Back by popular demand! Thank you so much for the feedback!
- We've improved the layout of Favorites when you have more than 4.
- CMD Z and CMD SHIFT T will now reopen a closed Peek, like they re-open closed tabs.
- Hover and drag over GMeet PiP with two fingers to move it around! You can now also pinch on your trackpad to resize GMeet PiP.
- We've added support for right click on the back / forward buttons in the Toolbar.
- We've made performance improvements to the Downloads panel in Library.
- We've removed the black bar when watching fullscreen video and improved the transition into fullscreen.
- You can now turn off tab haptics in Arc Settings by hitting CMD T and typing "Advanced Preferences".
- We've removed the page dimmer when hitting CTRL Tab to switch Tabs.
- We've changed the default Command Bar options when in a Profile without search history.
- Hit CMD T and type "Copy URL as Markdown", now supported in Peek, too!
- Duplicating a tab (right click … Duplicate) now duplicates its history, too.
- 1.5.1 - repaired a GMeet bug affecting Little Arc and Blank Windows.

##

## August 17, 2023 —

**V1.4.0**

- We've fixed a potential source of CPU consumption and battery drain by optimizing the way Arc interacts with the Mac's filesystem to show downloads and other files.
- We've made improvements to automatic tab suspension to save RAM and increase speed.
- The Gmail Preview will now handle accented characters.
- Folder previews will now show custom tab titles if they exist.
- We've slightly refined the look of selected tabs.
- We've improved our Toolbar color logic (View > Show Toolbar).
- We've fixed a bug that occasionally caused Previews to not load.
- Pinned Tabs will now resolve to the correct title after the URL redirects.
- We've fixed a bug where the Arc window would briefly flicker when returning from Mission Control.

##

## August 10, 2023 —

**V1.3.0**

- We've made a brand new Space Creation flow to increase customization, profile selection, and delight!
- Switching Spaces will now switch your active tab to the last tab used in that Space.
- The Command Bar got a visual refresh, making you feel just a bit more speedy as you navigate.
- Google Meet PiP got an upgrade: it now offers more meeting controls, can be resized to show more meeting participants, and is more performant.
- Long-press on the Toolbar's back button will now show tab history.
- We added some light haptics when dragging a tab around your sidebar.
- We now show the tab overflow indicator while scrolling to better help you find your place.
- Moving a tab into a folder will now always "peek" the tab in the Folder so you don't loose your place.
- You can now rename a Space by simply clicking on your Space Title.
- We now only show the Incognito label in the Sidebar, rather than on top of the web contents.
- CMD Shift T and CMD Z now re-open a closed Peek, just like they reopen a closed tab.

## August 3, 2023 —

**V1.2.0**

- We've made early improvements to Command Bar search suggestion ranking. More to come soon!
- We now auto-open meeting links in a new tab, rather than in Peek, to avoid accidentally closing them.
- We've improved the performance of downloads in Arc. Downloading logic now runs independently, reducing the performance impact on the rest of Arc.
- You can now import multiple Profiles from a previous browser at once during Onboarding.
- CMD+0 now resets page zoom if you've zoomed in with a trackpad!
- We added a hotkey for toggling developer mode (CTRL-D). You can edit all shortcuts via Arc > Settings > Shortcuts.

##

## July 27, 2023 —

**V1.1.0**

- You can clear your entire Archive by going to Archive > Clear Archive in the Mac Menu Bar, or by right clicking on the Archive Icon in the Library.
- Hitting CMD + Option + V will now paste whatever's in your clipboard as new Tab!
- We've made performance improvements to how Space themes are rendered.
- We've made performance improvements to downloads.
- We've made performance improvements to website scrolling by improving the efficiency of hovering over links.

##

## July 21, 2023 —

**V1.0.1**

Thanks for using Arc! We have a new version for you, including:

- You can opt into viewing a full URL Bar and pinned Extensions at all times by enabling the Toolbar! Head to View > Show Toolbar to turn on.
- Immediately start renaming tabs after they are Pinned!
- Option + Clicking on current tab will now duplicate that tab in Split View.
- We've made it easier to surface some common actions in the Command Bar, like CMD T… "Move to [Space]" to quickly move your current tab and CMD T… "Settings" to open the Settings menu.
- You can now right-click on a Capture within an Easel to copy the Capture's source URL.
- We've put all Peek settings under Arc > Settings > Links.
- We've added a "Repro Steps" field to bugs shared in the Bug Reporter to help us better solve issues.
- Google Meet PiP now works for non English default languages.
- Welcome to Arc v1.0!

##

## July 13, 2023 —

**V0.112**

- Google Meet PiP! Navigating away from your Google Meet tab will automatically enable Picture in Picture (PiP) so you can continue to view your meeting as you browse! Turn off PiP anytime in Site Settings in the URL Bar.
- Introducing "Paste URL as New Tab"! When you copy a URL, you can now hit CMD T and type "Paste URL as New Tab" to open a new tab from your clipboard. You can also right click on a Folder to Paste the URL as New Tab within the Folder.
- We've brought back the ability to mute any tab by right-clicking on the tab (even if it's not actively playing audio).
- We've improved the performance of tab switching!

##

## July 6, 2023 —

**V0.111**

- We now show a little "overflow indicator" in the sidebar if your current tab is scrolled out of view.
- Shift + clicking on any link will now open it in Peek by default! You can turn this off in Arc > Settings > Links.
- When screen sharing a tab, we now show a clear indicator on that tab.
- By default, all Google Meet Links will open in your most recent Space.
- The Copy Link button in the URL Bar has returned!
- Boosts now live within the Site Control Center in your URL bar.
- We've improved the Command Bar ranking algorithm so you get better suggestions when you hit CMD T.
- Extensions now live under the Site Control button in the URL bar. Click here to access, pin, and manage extensions.
- You can now double-click on the empty space in your sidebar to create new tab!
- Clicking on a notification now takes you the tab that sent it, rather than opening a new tab. @connor
- We've fixed a bug that sometimes made the sidebar get stuck open.

##

## June 28, 2023 —

**V0.110**

- Introducing Boost Shuffle! Hit the paint brush icon in the URL at the top of your Sidebar to start editing any webpage. If you want some inspo, click the dropdown near your Boost’s name and select “Shuffle”. Keep your Boost as is, or edit to make it just right. Then hit share!
- To share a Boost quickly, CMD T and type “Share Boost” on any Boosted site.
- If you have a redundant ad blocker extension, you’ll now be prompted to remove it. Getting rid of extra extensions will speed up Arc significantly!
- We now only show the Edit button for your Space if you’re hovered over the Space Title.
- We fixed a security vulnerability in Notes / Easels. Thanks to Elijah, an Arc Member, for catching this!
- We’ve made an early improvement to crashes caused by RAM spikes.

##

## June 22, 2023 —

**V0.109**

- Access the Boost Gallery right from your Library. Just click the Library icon in the bottom-left corner of the Sidebar to get started.
- A new badge will appear over Favorites that you're currently sharing to a video chat.
- Bug fix for Extensions disappearing from the menu.
- Dragging a tab out of your sidebar to create a new window will now keep your tab exactly where it was — versus creating a blank window.

##

## June 15, 2023 —

**V0.108**

- Secure sites no longer show the lock icon in the address bar. Insecure sites will show an insecure icon loud and clear.
- Arc has a new Site Control Center in the sidebar's address bar! Click here to flip on and off site specific settings like Location access and Picture in Picture.
- Extension import now helps ensure you only import one ad blocker, greatly improving performance.
- We've increased discoverability of the "New Note (in Split)" action. Hit CMD T and type "New Note Split" to jot notes alongside your current webpage - super handy!
- Hover over your Space title and click the "Edit" button to edit your Space's theme profile, etc.
- Right click menus on Spaces and Tabs have been simplified.
- We've fixed a bug that can sometimes remove your custom tab title.
- We've fixed a bug where Picture in Picture and audio would continue after closing a Favorited Tab.
- We've fixed a bug where you'd "jump" to the wrong macOS desktop when using CMD + tab or three finger swipe on trackpad.
- We've fixed a memory leak that may have caused recent performance issues.
- We've fixed a bug in Google Meet where Picture in Picture during a video call didn't work.

##

## June 8, 2023 —

**V0.107**

- You can now more easily ask a question to the team by hitting CMD T and typing "Ask Question". While you're here, you'll see some additional improvements to our Contact window: a better media uploader, a repro steps section for Urgent Bugs, and a new Update reminder!
- Hitting CMD L and Enter in the Command Bar will now refresh the current page, if selected.
- Hit Cmd T or CMD L a second time after the Command Bar is already open to dismiss it.
- We've made some early performance improvements to Easel, more to come!
- We've fixed a bug that may have contributed to GPU crashes / video issues.
- Hitting ESC now closes the print dialogue.

##

## May 31, 2023 —

**V0.106**

- Windows in Arc now have unique Unpinned Tabs. Pinned tabs will still sync across Windows and devices.
- Introducing Folder Previews. Hover over any folder to search its contents and open the tabs inside.
- Switching to open tabs in Folders will now only show the single tab, rather than open the entire folder.
- We've fixed a bug where CMD SHIFT T didn't properly re-open a closed tab.
- Auto Archive time settings now sync across devices!
- We've made some small but mighty visual tweaks to the Sidebar.
- We've made improvements to speed while typing in the Command Bar!

##

## May 25, 2023 —

**V0.105**

- Introducing Boosts V2. Edit the internet, without a single line of code. Hit CMD T then type “Boost” to edit your current site! You can turn your boost on or off anytime in the address bar at the top of the sidebar. Your v1 Boosts can still be edited from the Extensions menu, and you can access the old editor by hitting CMD T and typing “New Legacy Boost.
- You can now search and perform any Arc action by hitting TAB in the command bar. Try hitting [TAB] then typing “split” to get a feel for it!
- Introducing a new preview for Confluence! Hover over pinned Confluence tabs to view and navigate to recent Confluence pages.
- Korean characters can now be used in the command bar. Thanks to all who sent feedback on this.
- We’ve made performance improvements to multi-device syncing.

##

## May 18, 2023 —

**V0.104**

- You can now delete Command Bar suggestions for pages you've visited and searches you've performed! Just hover over a suggestion and you'll see the new 'X' button appear.
- We've made some visual improvements to the Command Bar, like new shading and icons.
- We've made some early performance improvements to typing in the Command Bar!
- We've made improvements to Preview Performance.
- We've fixed an issue where Little Arc opened in the wrong macOS Desktop.

##

## May 11, 2023 —

**V0.103**

- We've improved the experience of translating a page! If you visit a site that's not in one of your preferred languages, you'll now be able to easily translate and un-translate at your convenience, right in the address bar.
- Developer Mode now keeps the Sidebar address bar in view to minimize "jumpiness" when moving between Dev Mode tabs and other tabs.
- The minimum macOS version for Arc is now 12.1.0. If you're on macOS 12.0.0 or 12.0.1, please update!
- We've fixed a bug that sometimes caused multiple windows to open when restarting Arc!
- [perf update] We've made early improvements to speed in the Command bar (CMD T) More to come!
- [perf update] We've made an update that favors use of the integrated GPU on your machine. This means some members may notice battery improvements.
- [perf update] We're now bypassing a known issue in macOS that may have resulted in extra memory usage. This means you may notice less ram usage from Arc.

##

## May 3, 2023 —

**V0.102**

- Introducing Air Traffic Control to automatically route links to the correct Space based on their domain! Hit CMD T and type "Link Preferences" to start flying.
- You can now drag the Arc window from the top bar of webpages themselves. Toggle this off in Preferences or opt out temporarily by holding CMD.
- Renaming Easels is no longer broken!
- [Perf update] We've made some early improvements to tab loading RAM. More to come!

##

## April 27, 2023 —

**`IMPROVEMENTS`**

- We've fixed an gnarly bug with Arc + Stage Manager that required clicking to focus the app.
- ctrl + shift + tab allows you to go back in the Tab-Switcher (ctrl + tab). ctrl + ` works for this too!
- We've improved the reliability of search engine suggestions in the Command Bar.
- Newly created spaces now appear next to your active space, rather than at the end of the Space list.
- [performance boost!] We've made some optimizations to hovering over items in Library.
- [performance boost!] We've made some early improvements to webpage loading (more to come!)

##

## April 20, 2023 —

**`FEATURES`**

- Links to Easels and Notes now open in Peek by default.
- The loading indicator is now visible when Arc is in full screen!
- Hovering on a link for 1.5 seconds will now expose your entire URL in the status bar, rather than just a preview.

**`IMPROVEMENTS`**

- The permissions dialog in the address bar is now responsive to different sized sidebars.
- We've fixed a bug that caused the URL to overlap with the camera and link icons in the address bar.
- We've fixed a bug with title animations in the audio player.

##

## April 13, 2023 —

**`FEATURES`**

- We now support Site Search! Hit CMD T and type "Site Search Settings" to get started. To use Site Search, start typing a set shortcut (e.g. "yt…" for YouTube), then [TAB].
- You can right click on a Folder to Duplicate it.

**`IMPROVEMENTS`**

- CTRL backtick now works in the CTRL Tab shortcut to go backwards (similarly to how CMD Tab works)!
- We've improved the animation for dropping a tab in Folder.
- The Space deletion confirmation now includes the Space's title.
- We've fixed a bug that prevented some members from viewing extensions on hover.
- We've fixed a bug that caused loading issues for tabs in Full Screen.

##

## Mar 30, 2023 —

**`FEATURES`**

- Arc for iPhone! Now available in the App Store. Access your Spaces and tabs on the go, save tabs for later from other apps, and much more.
- Easel & Notes in the Library now open in Peek! Hit CMD T and type "Open Library". Then head to Easels & Notes to browse, Peek, and edit.

**`IMPROVEMENTS`**

- Downloads in Library now include everything you've downloaded from the internet, rather than just the stuff in your MacOS Downloads Folder.
- We've fixed a longstanding bug with Gmail Preview not displaying on hover.
- We've fixed bug that made Sidebar get stuck on hover in some cases.

##

## Mar 23, 2023 —

**`FEATURES`**

- A Sync Indicator in Preferences! Hit CMD T and type "Account Preferences" to turn on Sync. You'll see a green light when Sync is on and you can hover to view last Sync time.

**`IMPROVEMENTS`**

- We've fixed a bug that broke the Sync button when iCloud is full. Thanks to all who reported this!
- CMD + Clicking on the reload button now duplicates your current tab, similar to other browsers.
- Mini Player (PiP) now works with videos in a Youtube playlist.
- Improved Peek animation performance and a new interactive dismiss gesture.
- Hit CMD T and type "What's new" to see the latest release notes anytime.

##

## Mar 16, 2023 —

**`FEATURES`**

- A Sync Indicator in Preferences! Hit CMD T and type "Account Preferences" to turn on Sync. You'll see a green light when Sync is on and you can hover to view last Sync time.

**`IMPROVEMENTS`**

- CMD + Clicking on the reload button now duplicates your current tab, similar to other browsers.
- We've fixed a bug that broke the Sync button when iCloud is full. Thanks to all who reported this!
- Mini Player (PiP) now works with videos in a Youtube playlist.
- Improved Peek animation performance and a new interactive dismiss gesture.
- Hit CMD T and type "What's new" to see the latest release notes anytime.

##

## Mar 9, 2023 —

**`FEATURES`**

- We've redesigned the Arc Preferences menu for more clarity and access to important settings! Hit CMD T and type "Preferences" to further tailor Arc to your needs.
- You can now overwrite your Sidebar synced in iCloud with your current, local Sidebar. Hit CMD T and type "Preferences" to adjust your Sync settings. This function is useful when you're setting up Arc on a second device for the first time.
- You can now delete files from your computer completely by right-clicking on the file in your Library.
- Right click on the Library icon in the bottom left of your Sidebar to allow or disallow Screenshots in Library.

**`IMPROVEMENTS`**

- We've fixed the appearance of scroll bars in the Library Space Manager.
- We now support multiple Download animations at a time!
- Downloads in your Library now only include web downloads, rather than everything in your Downloads folder.
- We have fixed a bug that prevented detection of USB cameras for some members.
- We have updated to Chromium engine 111.0.5563.64.

##

## Mar 2, 2023 —

**`FEATURES`**

- You can now change the email associated with your account. To do this, hit CMD T and type "Preferences", then head to the Account tab.
- We now support zooming in the Mini Video Player by holding CMD and scrolling your mouse wheel.

**`IMPROVEMENTS`**

- Developer mode now works with your Sidebar hidden! Thank you to all who reported this bug.
- We've fixed a bug in our CMD T logic that over-prioritized submitting URLs over submitting to your search-engine.
- The Copy Url button in the Address Bar now works on your active Peek window.

##

## Feb 23, 2023 —

**`FEATURES`**

- Library 2.0! Library is now a better, cleaner home for your Media, Downloads, Easels & Notes, and Archived Tabs. Archived Tabs are now also searchable! Check out Library by clicking the bottom-leftmost icon in your Sidebar or by hitting CMD T and typing "Library".
- Support for Vivaldi and Opera import! Bring in your history, cookies, passwords, autocomplete payment info, and bookmarks by heading to Arc > Import From Another Browser.
- Downloads now hop into the Library, rather than open as tabs. You can hover over the Library icon to access recent Downloads or view them all in the Library. We also now show Download progress!

**`IMPROVEMENTS`**

- We've made a fix that may have caused crashing for some members. Thanks for your patience here if you experienced this!
- We've ended Big Sur support. Members on Big Sur will still be able to use Arc, but will no longer get feature updates and important fixes. We highly recommend updating your Mac, if you can!

##

## Feb 16, 2023 —

**`FEATURES`**

- Introducing Peek! Peek is a convenient way to preview sites from Pinned Tabs. Simply click on a new link from a Pinned or Favorited Tab, and Arc will automatically open that tab in Peek! Learn more by viewing the Peek Article via Help > Visit Help Center.

**`IMPROVEMENTS`**

- A New Loading Indicator! To see the loading progress of your webpage, direct your eyes to the top center of the Arc window for our new animation. We appreciate all the folks who requested this – can't wait to hear what you think!

##

## Feb 9, 2023 —

**`FEATURES`**

- Introducing Vertical Split View! You can now stack sites on top of each other (in addition to side by side!). Hit CMD T and type "Add Vertical Spit" or drag a tab from your sidebar to the top / bottom center of your screen.
- Smarter loading for Favorites. We used to keep your Favorites loaded at all times, but now we only load them if they've been used recently. This should keep things speedy without the extra resource consumption!
- Imported Bookmark Folders now have Folder Previews. Simply hover over the magnifying glass on a Folder and search within the Preview for a tab.
- Downloads from Arc now use macOS Gatekeeper to warn against potentially malicious files.

**`IMPROVEMENTS`**

- We've added more descriptive error messaging during Sign In.

##

## Feb 2, 2023 —

**`FEATURES`**

- The Bug Reporter now allows you to get to a Bug report from the Feedback Reporter and vice versa. Hit CMD T and type "Bug", "Feedback", or "Resources" anytime.
- Hitting CMD T and typing "Open Shortcuts" now will trigger the Shortcuts Editor in Preferences.

**`IMPROVEMENTS`**

- We now present a toast (a little notification) when a new Space is created when your sidebar is hidden.
- Capturing inside Little Arc, Blank Windows, or Incognito, now lets you save to an easel in your Sidebar. Hit CMD T and type "Capture" to give it a try.
- We've fixed a bug preventing Developer Mode from working on tabs moved from Little Arc.

##

## Jan 26, 2023 —

**`FEATURES`**

- An upgraded Arc Help Center! Hit CMD T ... and type "Help" to search for answers or chat with the team. This has replaced the "Ask a Question" box.
- The Recent Tab Switcher (which you can access via CTRL Tab) now has recording indicators if your camera is on.

**`IMPROVEMENTS`**

- A fix to a long standing bug that caused occasional freezing in full-screen (esp. during video!). Thank you so much for your patience and help through the months of investigating!
- CMD + up and CMD + down now let you move to the top and bottom of an Easel!
- Opening Picture in Picture from Spotify now includes previous and next track buttons.
- A fix to a bug in the Media Player that grayed out the play / pause buttons on occasion.

##

## Jan 19, 2023 —

**`FEATURES`**

- Hit CMD T and type "Manage Passwords" to easily view / manage passwords you've saved in Arc.

**`IMPROVEMENTS`**

- We've added a divider between "Sign Out" and "Quit" in the Mac Menu Bar (under "Arc") to help with accidental logouts.
- Little Arc will now always appear above your full screen window, that way it won't get lost.
- Capturing Arabic text will no longer cause a crash in Easels. Apologies to anyone who experienced this!
- Right clicking on a Folder and selecting Copy All Links will now include URLs in nested Folders.
- We've made a fix to a PiP bug that may have caused crashing for some Members.

##

## Jan 12, 2023 —

**`FEATURES`**

- The max number of Favorites in any Profile is now 12 (up from 8)!
- You can now edit a Pinned Tab's URL! Right click on a Pinned Tab, select "Pinned URL" and then "Edit Pinned URL". You can now Pin links that redirect without worry.
- Clearing Cache & Cookies per tab is now more accessible! Head to the lock in the URL bar and click "More Settings".
- We've removed the CMD N menu. CMD N now has extra speed and simply opens a second window. If you want a "Blank Window" Option, hit CTRL + CMD + N (or remap this in Shortcut Settings!)
- You can now filter your Archive for links closed in Little Arc. Hit CMD T and type "View Archive" to get there.
- You can now turn off Developer Mode in localhost! Hit the "info" icon in the URL bar to turn Dev Mode on / off.
- We've updated our AppleScript API, which allows native apps to better integrate with Arc! You can now query for spaces and tabs, and create new tabs and windows.

**`IMPROVEMENTS`**

- We've increased the performance of Favicon loading. This will help reduce the instances of missing Favicons in your sidebar.
- Playback Speed now works reliably in on the Mini Video Player.
- We've polished the Mini Video Player (even more)! Check out the latest animations & haptics.
- We've made performance improvements to tab hovering, tab dragging, and the Command Bar. You can now close tabs from the recent tab switcher (CTRL + TAB) by continuing to hold CTRL and tapping W.
- Youtube videos in the Mini Video Player will no longer auto re-play when they're finished.
- We've fixed a bug with URL editing while using Dev Mode on two Split Tabs.
- We now support Dark Mode in our Sign Up flow.
- We've removed even more tracking during Super Copy (CMD + SHIFT + C) on Amazon links.
- Arc Easel / Note icons now match your Space Theme.