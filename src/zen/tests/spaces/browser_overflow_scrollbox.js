/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function test_Check_ScrollBox_Overflow() {
  const scrollbox = gZenWorkspaces.activeScrollbox;
  scrollbox.smoothScroll = false;
  const selectedTab = gBrowser.selectedTab;
  const tabsToRemove = [];
  while (!scrollbox.overflowing) {
    await BrowserTestUtils.openNewForegroundTab(
      window.gBrowser,
      "https://example.com/",
      true
    );
    tabsToRemove.push(gBrowser.selectedTab);
  }

  // An extra tab to ensure the scrollbox is overflowing
  await BrowserTestUtils.openNewForegroundTab(
    window.gBrowser,
    "https://example.com/",
    true
  );
  tabsToRemove.push(gBrowser.selectedTab);

  const firstTab = gBrowser.visibleTabs.find(tab => scrollbox.contains(tab));
  while (
    scrollbox.scrollSize - scrollbox.scrollbox.clientHeight <=
    firstTab.getBoundingClientRect().top -
      scrollbox.scrollClientRect.top +
      scrollbox.scrollPosition
  ) {
    await BrowserTestUtils.openNewForegroundTab(
      window.gBrowser,
      "https://example.com/",
      true
    );
    tabsToRemove.push(gBrowser.selectedTab);
  }

  ok(
    scrollbox.overflowing,
    "The scrollbox should be overflowing after opening enough tabs"
  );

  Assert.strictEqual(
    scrollbox.scrollPosition,
    0,
    "The scrollbox should be scrolled to the top"
  );

  gBrowser.selectedTab = gBrowser.tabs[gBrowser.tabs.length - 1];
  await new Promise(resolve => {
    /* eslint-disable-next-line mozilla/no-arbitrary-setTimeout */
    setTimeout(() => {
      Assert.greater(
        scrollbox.scrollPosition,
        0,
        "The scrollbox should be scrolled to the bottom"
      );
      resolve();
    }, 200);
  });

  Assert.less(
    firstTab.getBoundingClientRect().top,
    scrollbox.scrollClientRect.top,
    "The first workspace tab starts clipped before scrolling back"
  );
  gBrowser.selectedTab = firstTab;
  await new Promise(resolve => {
    /* eslint-disable-next-line mozilla/no-arbitrary-setTimeout */
    setTimeout(() => {
      const rect = firstTab.getBoundingClientRect();
      const viewport = scrollbox.scrollClientRect;
      Assert.greaterOrEqual(
        rect.top,
        viewport.top,
        "The first workspace tab is not clipped above the viewport"
      );
      Assert.lessOrEqual(
        rect.bottom,
        viewport.bottom,
        "The first workspace tab fits inside the viewport"
      );
      resolve();
    }, 200);
  });
  gBrowser.selectedTab = selectedTab;
  for (const tab of tabsToRemove) {
    await BrowserTestUtils.removeTab(tab);
  }
});
