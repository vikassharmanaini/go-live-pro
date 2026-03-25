# Go Live Pro 🚀

**Go Live Pro** is the ultimate VS Code extension for web developers, providing a professional-grade development server with integrated Chromium DevTools, Screencasting, and Multi-root workspace support.

![Go Live Pro Icon](resources/icon.png)

## Features 🌟

- **Hot Reload**: Instant "save-to-reload" experience for all your HTML, CSS, and JS files.
- **Embedded Chromium Preview**: See your changes inside VS Code using a real Chromium browser.
- **Advanced DevTools**: 
    - **Console**: Live capture of logs, warnings, and errors.
    - **Elements**: Interactive element picker and inspector.
    - **Storage**: Real-time view of `localStorage`.
    - **Network+**: Capture and replay XHR/Fetch requests safely.
- **Screencast Mode**: High-performance canvas-based preview for a smooth feeling.
- **Responsive View**: Quickly test your site on **Mobile**, **Tablet**, and **Desktop** presets.
- **Multi-root Support**: Run multiple servers simultaneously in different workspace folders.
- **SPA Fallback**: Built-in support for Single Page Applications (React, Vue, Angular, etc.).
- **API Proxy**: Seamlessly forward backend requests to your API server.
- **Premium Settings UI**: Manage your configurations through a beautiful, modern interface.

## Quick Start 🏃‍♂️

1. Install the extension.
2. Open a workspace folder with an `index.html` file.
3. Click the **Go Live** icon in the status bar or right-click an HTML file and select `Go Live`.
4. Your site will open in your default browser, and you can also open the **Embedded Preview** from the status bar.

## Extension Settings ⚙️

- `go-live.port`: The port to run the server on (default: `5500`).
- `go-live.root`: The root directory to serve files from.
- `go-live.spa`: Enable Single Page Application fallback.
- `go-live.proxy`: URL to proxy backend requests to.
- `go-live.chromeExecutable`: Custom path to Chrome/Edge if auto-detection fails.

## Documentation 📚

Check the `doc/` folder for in-depth architectural and technical documentation:
- [Architecture Overview](doc/architecture.md)
- [Server Implementation](doc/server.md)
- [Webview & DevTools](doc/webviews.md)

## License 📄

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

---
Built with ❤️ for the VS Code community by [Vikas Sharma](https://github.com/vikassharmanaini).
