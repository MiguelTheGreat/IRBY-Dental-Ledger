// Native Windows Desktop Application for IRBY Dental Ledger.
// Compiled using Windows's built-in C# compiler (csc.exe) with embedded WebView2
// and automatic Microsoft Edge / Chrome app-mode fallback.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

[assembly: AssemblyTitle("IRBY Dental Ledger")]
[assembly: AssemblyDescription("Digital Dental Chart & Records Management System")]
[assembly: AssemblyCompany("IRBY Dental Clinic")]
[assembly: AssemblyProduct("IRBY Dental Ledger")]
[assembly: AssemblyVersion("1.1.0.0")]
[assembly: AssemblyFileVersion("1.1.0.0")]

namespace IrbyDentalLedger
{
    internal static class Program
    {
        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        private static string _nativeLoaderDir;

        [STAThread]
        private static void Main()
        {
            try { SetProcessDPIAware(); } catch { }

            bool createdNew;
            using (Mutex mutex = new Mutex(true, @"Local\IRBYDentalLedger_SingleInstance", out createdNew))
            {
                if (!createdNew)
                {
                    MessageBox.Show(
                        "IRBY Dental Ledger is already running on this computer.",
                        "IRBY Dental Ledger",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Information
                    );
                    return;
                }

                SetupEmbeddedAssemblies();
                RunApp();
            }
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static void RunApp()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm(_nativeLoaderDir));
        }

        private static void SetupEmbeddedAssemblies()
        {
            try
            {
                string appData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                _nativeLoaderDir = Path.Combine(appData, "IRBYDentalLedger", "native", "x64");
                Directory.CreateDirectory(_nativeLoaderDir);
                string loaderPath = Path.Combine(_nativeLoaderDir, "WebView2Loader.dll");
                ExtractResourceToFile("WebView2Loader.dll", loaderPath);
            }
            catch
            {
                // Ignore if already loaded or locked by another instance
            }

            AppDomain.CurrentDomain.AssemblyResolve += (sender, args) =>
            {
                string shortName = new AssemblyName(args.Name).Name + ".dll";
                using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(shortName))
                {
                    if (stream == null) return null;
                    byte[] data = new byte[stream.Length];
                    stream.Read(data, 0, data.Length);
                    return Assembly.Load(data);
                }
            };
        }

        private static void ExtractResourceToFile(string resourceName, string targetPath)
        {
            if (File.Exists(targetPath)) return;
            using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourceName))
            {
                if (stream == null) return;
                using (FileStream fs = new FileStream(targetPath, FileMode.Create, FileAccess.Write, FileShare.Read))
                {
                    stream.CopyTo(fs);
                }
            }
        }
    }

    internal sealed class MainForm : Form
    {
        private readonly string _nativeLoaderDir;
        private readonly string _projectRoot;
        private readonly int _serverPort = 3000;
        private Process _serverProcess;
        private Process _fallbackAppProcess;
        private WebView2 _webView;
        private CoreWebView2Environment _webViewEnv;
        private Panel _loadingPanel;
        private Label _loadingLabel;
        private Label _loadingSubLabel;
        private LinkLabel _lnkSwitchServer;
        private bool _isFullScreen;
        private FormWindowState _prevWindowState;
        private FormBorderStyle _prevBorderStyle;
        private string _targetServerUrl = null;
        private bool _isClientMode = false;
        private string _activeServerUrl = "http://localhost:3000";

        public MainForm(string nativeLoaderDir)
        {
            _nativeLoaderDir = nativeLoaderDir;
            _projectRoot = ResolveProjectRoot();

            LoadNetworkConfig();

            Text = "IRBY Dental Ledger";
            Size = new Size(1360, 860);
            MinimumSize = new Size(960, 640);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(243, 239, 234); // #F3EFEA warm clinic ivory

            try
            {
                Icon exeIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                if (exeIcon != null) Icon = exeIcon;
            }
            catch { }

            KeyPreview = true;
            KeyDown += OnMainFormKeyDown;

            BuildLoadingOverlay();

            Shown += OnMainFormShown;
            FormClosing += OnMainFormClosing;
        }

        private void OnMainFormKeyDown(object sender, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.F11)
            {
                ToggleFullScreen();
                e.Handled = true;
            }
            else if (e.Control && e.Shift && e.KeyCode == Keys.L)
            {
                ShowLanInfo();
                e.Handled = true;
            }
            else if (e.Control && e.Shift && e.KeyCode == Keys.C)
            {
                ShowServerConfigDialog();
                e.Handled = true;
            }
        }

        private static string ResolveProjectRoot()
        {
            string exeDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);

            // 1. Same directory as the .exe
            if (File.Exists(Path.Combine(exeDir, "server", "index.js")))
                return exeDir;

            // 2. Parent directory (e.g. if .exe is inside a bin/ or desktop/ subfolder)
            DirectoryInfo parent = Directory.GetParent(exeDir);
            if (parent != null && File.Exists(Path.Combine(parent.FullName, "server", "index.js")))
                return parent.FullName;

            // 3. Embedded resources/app directory
            string embedded = Path.Combine(exeDir, "resources", "app");
            if (File.Exists(Path.Combine(embedded, "server", "index.js")))
                return embedded;

            // 4. Current working directory fallback
            return Environment.CurrentDirectory;
        }

        private void BuildMenuBar()
        {
            MenuStrip menuStrip = new MenuStrip
            {
                BackColor = Color.FromArgb(248, 245, 240),
                ForeColor = Color.FromArgb(45, 35, 30),
                Font = new Font("Segoe UI", 9.5f, FontStyle.Regular)
            };

            // Clinic Menu
            ToolStripMenuItem clinicMenu = new ToolStripMenuItem("&Clinic");

            ToolStripMenuItem lanItem = new ToolStripMenuItem("Show &LAN Address for Tablets…", null, (s, e) => ShowLanInfo())
            {
                ShortcutKeys = Keys.Control | Keys.L
            };
            ToolStripMenuItem dataFolderItem = new ToolStripMenuItem("Open &Data && Backups Folder", null, (s, e) => OpenDataFolder())
            {
                ShortcutKeys = Keys.Control | Keys.D
            };
            ToolStripMenuItem openBrowserItem = new ToolStripMenuItem("Open in Default &Browser", null, (s, e) => OpenInBrowser())
            {
                ShortcutKeys = Keys.Control | Keys.B
            };
            ToolStripMenuItem printItem = new ToolStripMenuItem("&Print / Save as PDF…", null, (s, e) => PrintPage())
            {
                ShortcutKeys = Keys.Control | Keys.P
            };
            ToolStripMenuItem exitItem = new ToolStripMenuItem("E&xit", null, (s, e) => Close())
            {
                ShortcutKeys = Keys.Alt | Keys.F4
            };

            clinicMenu.DropDownItems.Add(lanItem);
            clinicMenu.DropDownItems.Add(dataFolderItem);
            clinicMenu.DropDownItems.Add(openBrowserItem);
            clinicMenu.DropDownItems.Add(new ToolStripSeparator());
            clinicMenu.DropDownItems.Add(printItem);
            clinicMenu.DropDownItems.Add(new ToolStripSeparator());
            clinicMenu.DropDownItems.Add(exitItem);

            // Edit Menu
            ToolStripMenuItem editMenu = new ToolStripMenuItem("&Edit");
            editMenu.DropDownItems.Add(new ToolStripMenuItem("&Undo", null, (s, e) => ExecEditorCommand("undo")) { ShortcutKeys = Keys.Control | Keys.Z });
            editMenu.DropDownItems.Add(new ToolStripMenuItem("&Redo", null, (s, e) => ExecEditorCommand("redo")) { ShortcutKeys = Keys.Control | Keys.Y });
            editMenu.DropDownItems.Add(new ToolStripSeparator());
            editMenu.DropDownItems.Add(new ToolStripMenuItem("Cu&t", null, (s, e) => ExecEditorCommand("cut")) { ShortcutKeys = Keys.Control | Keys.X });
            editMenu.DropDownItems.Add(new ToolStripMenuItem("&Copy", null, (s, e) => ExecEditorCommand("copy")) { ShortcutKeys = Keys.Control | Keys.C });
            editMenu.DropDownItems.Add(new ToolStripMenuItem("&Paste", null, (s, e) => ExecEditorCommand("paste")) { ShortcutKeys = Keys.Control | Keys.V });
            editMenu.DropDownItems.Add(new ToolStripMenuItem("Select &All", null, (s, e) => ExecEditorCommand("selectAll")) { ShortcutKeys = Keys.Control | Keys.A });

            // View Menu
            ToolStripMenuItem viewMenu = new ToolStripMenuItem("&View");
            viewMenu.DropDownItems.Add(new ToolStripMenuItem("&Reload", null, (s, e) => ReloadPage()) { ShortcutKeys = Keys.Control | Keys.R });
            viewMenu.DropDownItems.Add(new ToolStripSeparator());
            viewMenu.DropDownItems.Add(new ToolStripMenuItem("Actual &Size (100%)", null, (s, e) => SetZoom(1.0)) { ShortcutKeys = Keys.Control | Keys.D0 });
            viewMenu.DropDownItems.Add(new ToolStripMenuItem("Zoom &In", null, (s, e) => AdjustZoom(0.1)) { ShortcutKeys = Keys.Control | Keys.Oemplus });
            viewMenu.DropDownItems.Add(new ToolStripMenuItem("Zoom &Out", null, (s, e) => AdjustZoom(-0.1)) { ShortcutKeys = Keys.Control | Keys.OemMinus });
            viewMenu.DropDownItems.Add(new ToolStripSeparator());
            viewMenu.DropDownItems.Add(new ToolStripMenuItem("Toggle &Full Screen", null, (s, e) => ToggleFullScreen()) { ShortcutKeys = Keys.F11 });
            viewMenu.DropDownItems.Add(new ToolStripSeparator());
            viewMenu.DropDownItems.Add(new ToolStripMenuItem("&Developer Tools", null, (s, e) => OpenDevTools()) { ShortcutKeys = Keys.F12 });

            // Help Menu
            ToolStripMenuItem helpMenu = new ToolStripMenuItem("&Help");
            helpMenu.DropDownItems.Add(new ToolStripMenuItem("&About IRBY Dental Ledger", null, (s, e) => ShowAboutDialog()));

            menuStrip.Items.Add(clinicMenu);
            menuStrip.Items.Add(editMenu);
            menuStrip.Items.Add(viewMenu);
            menuStrip.Items.Add(helpMenu);

            MainMenuStrip = menuStrip;
            Controls.Add(menuStrip);
        }

        private void BuildLoadingOverlay()
        {
            _loadingPanel = new Panel
            {
                Dock = DockStyle.Fill,
                BackColor = Color.FromArgb(243, 239, 234)
            };

            _loadingLabel = new Label
            {
                Text = "IRBY Dental Ledger",
                Font = new Font("Segoe UI Semibold", 18f, FontStyle.Bold),
                ForeColor = Color.FromArgb(62, 47, 39),
                AutoSize = false,
                TextAlign = ContentAlignment.BottomCenter,
                Dock = DockStyle.None,
                Height = 45,
                Width = 600
            };

            _loadingSubLabel = new Label
            {
                Text = "Starting local clinic server & encrypted database…",
                Font = new Font("Segoe UI", 10.5f, FontStyle.Regular),
                ForeColor = Color.FromArgb(111, 104, 96),
                AutoSize = false,
                TextAlign = ContentAlignment.TopCenter,
                Dock = DockStyle.None,
                Height = 60,
                Width = 600
            };

            _lnkSwitchServer = new LinkLabel
            {
                Text = _isClientMode
                    ? string.Format("Workstation Mode: Connected to {0} · [Change / Host Server]", _targetServerUrl)
                    : "Workstation Mode: Central Server (This PC) · [Connect to Central Server]",
                Font = new Font("Segoe UI", 9f),
                LinkColor = Color.FromArgb(62, 47, 39),
                ActiveLinkColor = Color.FromArgb(212, 163, 115),
                AutoSize = false,
                TextAlign = ContentAlignment.TopCenter,
                Dock = DockStyle.None,
                Height = 26,
                Width = 600,
                Cursor = Cursors.Hand
            };
            _lnkSwitchServer.Click += (s, e) => ShowServerConfigDialog();

            _loadingPanel.Controls.Add(_loadingLabel);
            _loadingPanel.Controls.Add(_loadingSubLabel);
            _loadingPanel.Controls.Add(_lnkSwitchServer);
            _loadingPanel.Resize += (s, e) =>
            {
                int cx = (_loadingPanel.Width - 600) / 2;
                int cy = (_loadingPanel.Height / 2) - 45;
                _loadingLabel.Location = new Point(cx, cy);
                _loadingSubLabel.Location = new Point(cx, cy + 50);
                _lnkSwitchServer.Location = new Point(cx, cy + 115);
            };

            Controls.Add(_loadingPanel);
            _loadingPanel.BringToFront();
        }

        private async void OnMainFormShown(object sender, EventArgs e)
        {
            await EnsureServerAndLoadAsync();
        }

        private async Task EnsureServerAndLoadAsync()
        {
            if (_isClientMode && !string.IsNullOrEmpty(_targetServerUrl))
            {
                _activeServerUrl = _targetServerUrl;
                _loadingSubLabel.Text = string.Format("Connecting to Central Clinic Server at {0}…", _targetServerUrl);
                bool serverAlive = false;
                for (int i = 0; i < 20; i++)
                {
                    if (await Task.Run(() => CheckRemoteServerHealth(_targetServerUrl)))
                    {
                        serverAlive = true;
                        break;
                    }
                    await Task.Delay(250);
                }

                if (!serverAlive)
                {
                    DialogResult res = MessageBox.Show(
                        this,
                        string.Format(
                            "Could not connect to Central Clinic Server at:\n{0}\n\n" +
                            "Make sure:\n" +
                            "1. The Central Server PC is turned on and connected to this Wi-Fi network.\n" +
                            "2. IRBY Dental Ledger is running on the Central Server PC.\n" +
                            "3. Windows Firewall allows incoming connections on port 3000.\n\n" +
                            "Click [Retry] to attempt connecting again.\n" +
                            "Click [Cancel] to change the Central Server IP or switch to Host Server Mode.",
                            _targetServerUrl
                        ),
                        "Central Server Unreachable",
                        MessageBoxButtons.RetryCancel,
                        MessageBoxIcon.Warning
                    );

                    if (res == DialogResult.Retry)
                    {
                        await EnsureServerAndLoadAsync();
                        return;
                    }
                    else
                    {
                        ShowServerConfigDialog();
                        return;
                    }
                }

                await InitializeBrowserViewAsync(_targetServerUrl);
                return;
            }

            _activeServerUrl = string.Format("http://localhost:{0}", _serverPort);
            bool alreadyAlive = await Task.Run(() => CheckServerHealth());
            if (!alreadyAlive)
            {
                string nodeBin = FindNodeBinary();
                if (string.IsNullOrEmpty(nodeBin))
                {
                    nodeBin = await DownloadPortableNodeAsync();
                    if (string.IsNullOrEmpty(nodeBin))
                    {
                        PromptToInstallNode();
                        return;
                    }
                }

                _loadingSubLabel.Text = "Starting local clinic server & encrypted database…";
                if (!StartNodeServer(nodeBin))
                    return;

                bool ready = false;
                for (int i = 0; i < 50; i++)
                {
                    await Task.Delay(200);
                    if (await Task.Run(() => CheckServerHealth()))
                    {
                        ready = true;
                        break;
                    }
                }

                if (!ready)
                {
                    MessageBox.Show(
                        this,
                        string.Format(
                            "Could not reach http://localhost:{0} within 10 seconds.\n\nEnsure Node.js 22.13+ is installed and project files exist at:\n{1}",
                            _serverPort,
                            _projectRoot
                        ),
                        "Server Startup Timed Out",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Warning
                    );
                    return;
                }
            }

            await InitializeBrowserViewAsync(_activeServerUrl);
        }

        private async Task InitializeBrowserViewAsync(string appUrl = null)
        {
            if (string.IsNullOrEmpty(appUrl))
            {
                appUrl = !string.IsNullOrEmpty(_activeServerUrl)
                    ? _activeServerUrl
                    : string.Format("http://localhost:{0}", _serverPort);
            }
            try
            {
                if (!string.IsNullOrEmpty(_nativeLoaderDir) && Directory.Exists(_nativeLoaderDir))
                {
                    try { CoreWebView2Environment.SetLoaderDllFolderPath(_nativeLoaderDir); } catch { }
                }

                string userDataFolder = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "IRBYDentalLedger",
                    "WebView2Data"
                );
                Directory.CreateDirectory(userDataFolder);

                _webViewEnv = await CoreWebView2Environment.CreateAsync(null, userDataFolder, null);

                _webView = new WebView2
                {
                    Dock = DockStyle.Fill,
                    DefaultBackgroundColor = Color.FromArgb(243, 239, 234)
                };
                _webView.KeyDown += OnMainFormKeyDown;

                Controls.Add(_webView);
                _webView.BringToFront();
                _loadingPanel.BringToFront();

                await _webView.EnsureCoreWebView2Async(_webViewEnv);

                _webView.CoreWebView2.PermissionRequested += (s, args) =>
                {
                    if (args.PermissionKind == CoreWebView2PermissionKind.Camera ||
                        args.PermissionKind == CoreWebView2PermissionKind.Microphone)
                    {
                        args.State = CoreWebView2PermissionState.Allow;
                    }
                };

                _webView.CoreWebView2.NewWindowRequested += OnNewWindowRequested;

                _webView.CoreWebView2.NavigationCompleted += (s, args) =>
                {
                    if (_loadingPanel.Visible)
                    {
                        _loadingPanel.Visible = false;
                    }
                };

                _webView.CoreWebView2.Navigate(appUrl);
            }
            catch
            {
                // Fallback if WebView2 runtime is not installed: open standalone Edge/Chrome --app window
                LaunchAppBrowserFallback(appUrl);
            }
        }

        private void OnNewWindowRequested(object sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            string uri = e.Uri ?? "";
            string prefixActive = (_activeServerUrl ?? "").TrimEnd('/');
            string prefixLocal = string.Format("http://localhost:{0}", _serverPort);
            string prefixLoop = string.Format("http://127.0.0.1:{0}", _serverPort);

            if ((!string.IsNullOrEmpty(prefixActive) && uri.StartsWith(prefixActive, StringComparison.OrdinalIgnoreCase)) ||
                uri.StartsWith(prefixLocal, StringComparison.OrdinalIgnoreCase) ||
                uri.StartsWith(prefixLoop, StringComparison.OrdinalIgnoreCase))
            {
                e.Handled = true;
                OpenPrintChildWindow(uri);
            }
            else if (!string.IsNullOrEmpty(uri))
            {
                e.Handled = true;
                try { Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true }); } catch { }
            }
        }

        private async void OpenPrintChildWindow(string uri)
        {
            Form child = new Form
            {
                Text = "IRBY Dental Ledger — Print / PDF",
                Size = new Size(980, 820),
                MinimumSize = new Size(720, 540),
                StartPosition = FormStartPosition.CenterParent,
                BackColor = Color.White,
                Icon = Icon
            };

            WebView2 childWebView = new WebView2
            {
                Dock = DockStyle.Fill,
                DefaultBackgroundColor = Color.White
            };
            child.Controls.Add(childWebView);
            child.Show(this);

            try
            {
                await childWebView.EnsureCoreWebView2Async(_webViewEnv);
                childWebView.CoreWebView2.Navigate(uri);
            }
            catch
            {
                try { Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true }); } catch { }
                child.Close();
            }
        }

        private void LaunchAppBrowserFallback(string url)
        {
            _loadingSubLabel.Text = "Running in Desktop Browser Window (" + url + ")…\nClose this window when you are done to stop the clinic server.";

            string[] browserCandidates = new[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Microsoft\Edge\Application\msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Microsoft\Edge\Application\msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Google\Chrome\Application\chrome.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Google\Chrome\Application\chrome.exe")
            };

            foreach (string browser in browserCandidates)
            {
                if (File.Exists(browser))
                {
                    try
                    {
                        string profileDir = Path.Combine(
                            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                            "IRBYDentalLedger",
                            "AppBrowserProfile"
                        );
                        Directory.CreateDirectory(profileDir);

                        ProcessStartInfo psi = new ProcessStartInfo
                        {
                            FileName = browser,
                            Arguments = string.Format("--app=\"{0}\" --window-size=1360,860 --user-data-dir=\"{1}\"", url, profileDir),
                            UseShellExecute = false
                        };
                        _fallbackAppProcess = Process.Start(psi);
                        if (_fallbackAppProcess != null)
                        {
                            WindowState = FormWindowState.Minimized;
                            Task.Run(() =>
                            {
                                try
                                {
                                    _fallbackAppProcess.WaitForExit();
                                    BeginInvoke(new Action(Close));
                                }
                                catch { }
                            });
                            return;
                        }
                    }
                    catch { }
                }
            }

            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
        }

        private bool CheckServerHealth()
        {
            try
            {
                string healthUrl = string.Format("http://127.0.0.1:{0}/api/health", _serverPort);
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(healthUrl);
                req.Timeout = 600;
                req.ReadWriteTimeout = 600;
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                {
                    return resp.StatusCode == HttpStatusCode.OK;
                }
            }
            catch
            {
                return false;
            }
        }

        private string FindNodeBinary()
        {
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            string userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            string progFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string progFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);

            List<string> candidates = new List<string>
            {
                Path.Combine(_projectRoot, "runtime", "node.exe"),
                Path.Combine(_projectRoot, "node", "node.exe"),
                Path.Combine(progFiles, "nodejs", "node.exe"),
                Path.Combine(progFilesX86, "nodejs", "node.exe"),
                Path.Combine(localAppData, "Programs", "nodejs", "node.exe"),
                Path.Combine(userProfile, ".volta", "bin", "node.exe"),
                Path.Combine(appData, "fnm", "aliases", "default", "node.exe"),
                Path.Combine(localAppData, "fnm", "aliases", "default", "node.exe")
            };

            foreach (string path in candidates)
            {
                if (!string.IsNullOrEmpty(path) && File.Exists(path))
                    return path;
            }

            // Check nvm-windows directories
            string[] nvmRoots = new[]
            {
                Path.Combine(appData, "nvm"),
                Path.Combine(localAppData, "nvm")
            };
            foreach (string nvmDir in nvmRoots)
            {
                if (Directory.Exists(nvmDir))
                {
                    string[] subdirs = Directory.GetDirectories(nvmDir, "v*");
                    Array.Sort(subdirs);
                    for (int i = subdirs.Length - 1; i >= 0; i--)
                    {
                        string nodePath = Path.Combine(subdirs[i], "node.exe");
                        if (File.Exists(nodePath))
                            return nodePath;
                    }
                }
            }

            // Check PATH via where.exe
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo
                {
                    FileName = "where.exe",
                    Arguments = "node.exe",
                    RedirectStandardOutput = true,
                    UseShellExecute = false,
                    CreateNoWindow = true
                };
                using (Process p = Process.Start(psi))
                {
                    if (p != null)
                    {
                        string output = p.StandardOutput.ReadToEnd();
                        p.WaitForExit(2000);
                        if (p.ExitCode == 0 && !string.IsNullOrWhiteSpace(output))
                        {
                            string[] lines = output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries);
                            foreach (string line in lines)
                            {
                                string trimmed = line.Trim();
                                if (File.Exists(trimmed))
                                    return trimmed;
                            }
                        }
                    }
                }
            }
            catch { }

            return null;
        }

        private async Task<string> DownloadPortableNodeAsync()
        {
            try
            {
                string runtimeDir = Path.Combine(_projectRoot, "runtime");
                Directory.CreateDirectory(runtimeDir);
                string targetExe = Path.Combine(runtimeDir, "node.exe");
                string tempExe = Path.Combine(runtimeDir, "node.exe.download");

                _loadingSubLabel.Text = "First-run setup: downloading portable Node.js v22 LTS runtime…";

                ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
                using (WebClient wc = new WebClient())
                {
                    wc.DownloadProgressChanged += (s, e) =>
                    {
                        try
                        {
                            BeginInvoke(new Action(() =>
                            {
                                _loadingSubLabel.Text = string.Format(
                                    "First-run setup: downloading portable Node.js v22 LTS runtime ({0}%)…",
                                    e.ProgressPercentage
                                );
                            }));
                        }
                        catch { }
                    };

                    await wc.DownloadFileTaskAsync(
                        new Uri("https://nodejs.org/dist/v22.14.0/win-x64/node.exe"),
                        tempExe
                    );
                }

                if (File.Exists(tempExe) && new FileInfo(tempExe).Length > 10 * 1024 * 1024)
                {
                    if (File.Exists(targetExe)) File.Delete(targetExe);
                    File.Move(tempExe, targetExe);
                    return targetExe;
                }
            }
            catch { }

            return null;
        }

        private void PromptToInstallNode()
        {
            DialogResult resp = MessageBox.Show(
                this,
                "IRBY Dental Ledger requires Node.js (v22 LTS or newer) to run the local clinic records and encrypted SQLite database.\n\n" +
                "Click [Yes] to automatically download and launch the official Node.js Windows Installer (.msi) now.\n" +
                "Click [No] to open nodejs.org in your browser.\n" +
                "Click [Cancel] to exit.",
                "Node.js Required — IRBY Dental Ledger",
                MessageBoxButtons.YesNoCancel,
                MessageBoxIcon.Information
            );

            if (resp == DialogResult.Yes)
            {
                string setupBat = Path.Combine(_projectRoot, "Install-Node-Windows.bat");
                if (File.Exists(setupBat))
                {
                    try
                    {
                        Process.Start(new ProcessStartInfo(setupBat)
                        {
                            WorkingDirectory = _projectRoot,
                            UseShellExecute = true
                        });
                    }
                    catch { }
                }
                else
                {
                    try
                    {
                        Process.Start(new ProcessStartInfo("https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi")
                        {
                            UseShellExecute = true
                        });
                    }
                    catch { }
                }
            }
            else if (resp == DialogResult.No)
            {
                try
                {
                    Process.Start(new ProcessStartInfo("https://nodejs.org/en/download")
                    {
                        UseShellExecute = true
                    });
                }
                catch { }
            }

            Close();
        }

        private bool StartNodeServer(string nodeBin)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo
                {
                    FileName = nodeBin,
                    Arguments = "--disable-warning=ExperimentalWarning server/index.js",
                    WorkingDirectory = _projectRoot,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden
                };

                _serverProcess = Process.Start(psi);
                return _serverProcess != null;
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    this,
                    "Could not start IRBY Dental Ledger server:\n\n" + ex.Message,
                    "Server Startup Error",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
                return false;
            }
        }

        private void ReloadPage()
        {
            if (_webView != null && _webView.CoreWebView2 != null)
            {
                _webView.CoreWebView2.Reload();
            }
        }

        private void SetZoom(double factor)
        {
            if (_webView != null)
            {
                _webView.ZoomFactor = Math.Max(0.5, Math.Min(2.5, factor));
            }
        }

        private void AdjustZoom(double delta)
        {
            if (_webView != null)
            {
                SetZoom(_webView.ZoomFactor + delta);
            }
        }

        private void ToggleFullScreen()
        {
            if (!_isFullScreen)
            {
                _prevWindowState = WindowState;
                _prevBorderStyle = FormBorderStyle;
                FormBorderStyle = FormBorderStyle.None;
                WindowState = FormWindowState.Maximized;
                _isFullScreen = true;
            }
            else
            {
                FormBorderStyle = _prevBorderStyle;
                WindowState = _prevWindowState;
                _isFullScreen = false;
            }
        }

        private void OpenDevTools()
        {
            if (_webView != null && _webView.CoreWebView2 != null)
            {
                _webView.CoreWebView2.OpenDevToolsWindow();
            }
        }

        private void ExecEditorCommand(string cmd)
        {
            if (_webView != null && _webView.CoreWebView2 != null)
            {
                _webView.CoreWebView2.ExecuteScriptAsync("document.execCommand('" + cmd + "');");
            }
        }

        private void OpenDataFolder()
        {
            string dataPath = Path.Combine(_projectRoot, "data");
            Directory.CreateDirectory(dataPath);
            try
            {
                Process.Start(new ProcessStartInfo("explorer.exe", "\"" + dataPath + "\"")
                {
                    UseShellExecute = true
                });
            }
            catch { }
        }

        private void OpenInBrowser()
        {
            string url = string.Format("http://localhost:{0}", _serverPort);
            try
            {
                Process.Start(new ProcessStartInfo(url)
                {
                    UseShellExecute = true
                });
            }
            catch { }
        }

        private void PrintPage()
        {
            if (_webView != null && _webView.CoreWebView2 != null)
            {
                try
                {
                    _webView.CoreWebView2.ShowPrintUI();
                }
                catch
                {
                    _webView.CoreWebView2.ExecuteScriptAsync("window.print();");
                }
            }
        }

        private void ShowLanInfo()
        {
            List<string> addresses = new List<string>();
            try
            {
                foreach (NetworkInterface ni in NetworkInterface.GetAllNetworkInterfaces())
                {
                    if (ni.OperationalStatus != OperationalStatus.Up ||
                        ni.NetworkInterfaceType == NetworkInterfaceType.Loopback)
                        continue;

                    foreach (UnicastIPAddressInformation ip in ni.GetIPProperties().UnicastAddresses)
                    {
                        if (ip.Address.AddressFamily == AddressFamily.InterNetwork &&
                            !IPAddress.IsLoopback(ip.Address))
                        {
                            addresses.Add(string.Format("http://{0}:{1}", ip.Address, _serverPort));
                        }
                    }
                }
            }
            catch { }

            string list = addresses.Count > 0
                ? string.Join("\n", addresses.ToArray())
                : "No active LAN IPv4 address detected.";

            MessageBox.Show(
                this,
                string.Format(
                    "Open any of these URLs on chairside tablets or computers on the same Wi-Fi network:\n\n{0}\n\nLocal PC: http://localhost:{1}",
                    list,
                    _serverPort
                ),
                "Connect Chairside Tablets (LAN)",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information
            );
        }

        private string GetNetworkConfigFile()
        {
            string dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "IRBYDentalLedger");
            Directory.CreateDirectory(dir);
            return Path.Combine(dir, "network-server.txt");
        }

        private void LoadNetworkConfig()
        {
            try
            {
                string cfg = GetNetworkConfigFile();
                if (File.Exists(cfg))
                {
                    string text = File.ReadAllText(cfg).Trim();
                    if (!string.IsNullOrEmpty(text) && text.StartsWith("http", StringComparison.OrdinalIgnoreCase))
                    {
                        _targetServerUrl = text.TrimEnd('/');
                        _isClientMode = true;
                    }
                }
            }
            catch { }
        }

        private static bool CheckRemoteServerHealth(string baseUrl)
        {
            try
            {
                string healthUrl = baseUrl.TrimEnd('/') + "/api/health";
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(healthUrl);
                req.Timeout = 1800;
                req.ReadWriteTimeout = 1800;
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                {
                    return resp.StatusCode == HttpStatusCode.OK;
                }
            }
            catch
            {
                return false;
            }
        }

        private void ShowServerConfigDialog()
        {
            Form dlg = new Form
            {
                Text = "Clinic Workstation Network Setup",
                Size = new Size(540, 360),
                StartPosition = FormStartPosition.CenterParent,
                FormBorderStyle = FormBorderStyle.FixedDialog,
                MaximizeBox = false,
                MinimizeBox = false,
                BackColor = Color.FromArgb(243, 239, 234),
                Icon = Icon
            };

            Label title = new Label
            {
                Text = "Multi-PC Clinic Network Setup",
                Font = new Font("Segoe UI Semibold", 13f, FontStyle.Bold),
                ForeColor = Color.FromArgb(62, 47, 39),
                Location = new Point(22, 18),
                AutoSize = true
            };

            RadioButton rbHost = new RadioButton
            {
                Text = "Host Server Mode (This PC runs the Central Database & Server)",
                Font = new Font("Segoe UI Semibold", 9.5f),
                ForeColor = Color.FromArgb(42, 34, 29),
                Location = new Point(24, 60),
                Size = new Size(480, 24),
                Checked = !_isClientMode
            };

            Label lblHostDesc = new Label
            {
                Text = "Select this for the main clinic computer (front desk or server PC). Other PCs and tablets connect to this machine.",
                Font = new Font("Segoe UI", 8.5f),
                ForeColor = Color.FromArgb(111, 104, 96),
                Location = new Point(44, 86),
                Size = new Size(450, 32)
            };

            RadioButton rbClient = new RadioButton
            {
                Text = "Workstation Client Mode (Connect to another Central Server PC)",
                Font = new Font("Segoe UI Semibold", 9.5f),
                ForeColor = Color.FromArgb(42, 34, 29),
                Location = new Point(24, 126),
                Size = new Size(480, 24),
                Checked = _isClientMode
            };

            Label lblUrl = new Label
            {
                Text = "Central Server Address (IP or Hostname):",
                Font = new Font("Segoe UI", 9f),
                Location = new Point(44, 154),
                AutoSize = true
            };

            TextBox txtUrl = new TextBox
            {
                Text = !string.IsNullOrEmpty(_targetServerUrl) ? _targetServerUrl : "http://192.168.1.100:3000",
                Font = new Font("Segoe UI", 9.5f),
                Location = new Point(44, 176),
                Size = new Size(330, 26),
                Enabled = _isClientMode
            };

            Button btnTest = new Button
            {
                Text = "Test Link",
                Font = new Font("Segoe UI", 8.5f),
                Location = new Point(382, 175),
                Size = new Size(95, 28),
                Enabled = _isClientMode
            };

            Label lblTestResult = new Label
            {
                Text = "",
                Font = new Font("Segoe UI", 8.5f, FontStyle.Italic),
                Location = new Point(44, 206),
                Size = new Size(440, 20)
            };

            rbHost.CheckedChanged += (s, e) =>
            {
                txtUrl.Enabled = rbClient.Checked;
                btnTest.Enabled = rbClient.Checked;
            };

            btnTest.Click += async (s, e) =>
            {
                btnTest.Enabled = false;
                lblTestResult.ForeColor = Color.FromArgb(111, 104, 96);
                lblTestResult.Text = "Testing connection…";
                string url = txtUrl.Text.Trim();
                bool ok = await Task.Run(() => CheckRemoteServerHealth(url));
                if (ok)
                {
                    lblTestResult.ForeColor = Color.FromArgb(43, 122, 75);
                    lblTestResult.Text = "✓ Connection successful! Central Server is active.";
                }
                else
                {
                    lblTestResult.ForeColor = Color.FromArgb(180, 35, 24);
                    lblTestResult.Text = "✗ Cannot reach server. Verify IP, port 3000 & Wi-Fi connection.";
                }
                btnTest.Enabled = true;
            };

            Button btnSave = new Button
            {
                Text = "Save & Apply",
                Font = new Font("Segoe UI Semibold", 9.5f, FontStyle.Bold),
                BackColor = Color.FromArgb(62, 47, 39),
                ForeColor = Color.White,
                FlatStyle = FlatStyle.Flat,
                Location = new Point(275, 265),
                Size = new Size(130, 36),
                Cursor = Cursors.Hand
            };
            btnSave.FlatAppearance.BorderSize = 0;

            Button btnCancel = new Button
            {
                Text = "Cancel",
                Font = new Font("Segoe UI", 9f),
                BackColor = Color.White,
                Location = new Point(415, 265),
                Size = new Size(90, 36)
            };
            btnCancel.Click += (s, e) => dlg.Close();

            btnSave.Click += async (s, e) =>
            {
                string cfg = GetNetworkConfigFile();
                if (rbHost.Checked)
                {
                    try { if (File.Exists(cfg)) File.Delete(cfg); } catch { }
                    _isClientMode = false;
                    _targetServerUrl = null;
                }
                else
                {
                    string url = txtUrl.Text.Trim().TrimEnd('/');
                    if (!url.StartsWith("http://", StringComparison.OrdinalIgnoreCase) &&
                        !url.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
                    {
                        url = "http://" + url;
                    }
                    try { File.WriteAllText(cfg, url); } catch { }
                    _isClientMode = true;
                    _targetServerUrl = url;
                }
                dlg.Close();

                if (_loadingPanel != null) _loadingPanel.Visible = true;
                await EnsureServerAndLoadAsync();
            };

            dlg.Controls.Add(title);
            dlg.Controls.Add(rbHost);
            dlg.Controls.Add(lblHostDesc);
            dlg.Controls.Add(rbClient);
            dlg.Controls.Add(lblUrl);
            dlg.Controls.Add(txtUrl);
            dlg.Controls.Add(btnTest);
            dlg.Controls.Add(lblTestResult);
            dlg.Controls.Add(btnSave);
            dlg.Controls.Add(btnCancel);

            dlg.ShowDialog(this);
        }

        private void ShowAboutDialog()
        {
            MessageBox.Show(
                this,
                "IRBY Dental Ledger v1.1.0\n" +
                "Digital Dental Chart & Records Management System\n\n" +
                "• Offline-first single-clinic records & AES-256-GCM encrypted SQLite database\n" +
                "• Photo dental chart with PDA symbology (FDI & Universal numbering)\n" +
                "• Financial ledger, follow-up recall queue, and tamper-evident audit trail",
                "About IRBY Dental Ledger",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information
            );
        }

        private void OnMainFormClosing(object sender, FormClosingEventArgs e)
        {
            try
            {
                if (_serverProcess != null && !_serverProcess.HasExited)
                {
                    // Kill the whole tree: the server's OCR sidecar (python ocr-model/server.py,
                    // ~1 GB with TensorFlow loaded) would otherwise keep running after the window closes.
                    bool treeKilled = false;
                    try
                    {
                        using (Process tk = Process.Start(new ProcessStartInfo
                        {
                            FileName = "taskkill.exe",
                            Arguments = "/PID " + _serverProcess.Id + " /T /F",
                            UseShellExecute = false,
                            CreateNoWindow = true
                        }))
                        {
                            treeKilled = tk != null && tk.WaitForExit(5000);
                        }
                    }
                    catch { }
                    if (!treeKilled && !_serverProcess.HasExited) _serverProcess.Kill();
                    _serverProcess.Dispose();
                    _serverProcess = null;
                }
            }
            catch { }
        }
    }
}
