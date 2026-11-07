<!-- source: https://resources.arc.net/hc/en-us/articles/20855018192791 ; retrieved 2026-11-08 via web_extract (live Help Center pruned after Arc sunset) -->

# Site Search: Directly Search any Website

*This article applies to Arc for **macOS**, but not on Arc for Windows.*

## What is Site Search?

Site Search allows you to directly search any website from within Arc's Command Bar (Command-T)!

Site Search removes the added step of going to a website's landing page (e.g. Amazon.com), before making your search (e.g. "socks").

![Arc Site Search.gif](/hc/article_attachments/25705976514967)

## How to Add a Site for Site Search

### Add a Custom Site

- **Open Site Search settings by:**
  - Hitting Command-T and typing "Site Search", or
  - Heading to arc://settings/searchEngines.
- **Scroll to the "Site search" section and click "Add" (see image below).
![Add Site Search option in Arc browser.png](/hc/article_attachments/25705960749719)
**

- **Add the site's info:**
  - **Search engine**: this is a custom name for you to choose to easily identify the site. Choose the site's name, like "Twitter", "Youtube", "Amazon", etc
  - **Shortcut**: this is a custom shortcut of your choosing. This is the letter or symbol that you'll choose to summon Site Search. One or two letters works best so it's quick. For Youtube, a good one is "yt". For Twitter, try "tw". For Amazon, try "a".
  - **URL with %s in place of query**: this one requires precision! Go to the website of your choice and notice the query pattern on the URL.
    - Example:
      - If you go to Amazon and search for "socks", the URL will look something like this: https://www.amazon.com/s?k=socks&abc=xyz&ref=123
      - You'll notice that the URL before your search term (also called a query) is [https://www.amazon.com/s?k=](https://www.amazon.com/s?k=)
      - Now, simply take that query and add %s as a placeholder!
      - The result is https://www.amazon.com/s?k=%s. This is what you'd put in the final field.
  - **Hit Save** and you're set!

## How to Use Site Search

Once your Site Search has been added, you can start using it in Arc's Command bar (Command-T).

### To use Site Search:

- Hit Command-T
- Enter the shortcut from the site you want to search
- Hit Tab
- Enter a search term for your site
- Hit Enter
![How to use Site Search in Arc.gif](/hc/article_attachments/25705960752919)

Any site you search frequently is perfect! But, some of our team's favorites include:

- Youtube (https://www.youtube.com/results?search_query=%s)
- Amazon (https://www.amazon.com/s?k=%s)
- Twitter (https://twitter.com/search?q=%s)
- Spotify (https://open.spotify.com/search/%s)