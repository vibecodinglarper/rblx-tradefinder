"""Captures docs/screenshots/html/*.html to PNGs with Playwright. Run `npm run screenshots` first."""
import glob, os
from playwright.sync_api import sync_playwright

html = sorted(glob.glob('docs/screenshots/html/*.html'))
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(device_scale_factor=2, viewport={'width': 700, 'height': 900})
    for path in html:
        page.goto('file://' + os.path.abspath(path))
        page.wait_for_load_state('networkidle')
        page.wait_for_timeout(300)
        out = path.replace('/html/', '/').replace('.html', '.png')
        page.locator('#shot').screenshot(path=out)
        print('wrote', out)
    browser.close()
