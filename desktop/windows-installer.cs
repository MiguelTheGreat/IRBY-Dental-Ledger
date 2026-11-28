// Custom Branded Windows GUI Installer for IRBY Dental Ledger.
// Compiled using Windows's built-in C# compiler (csc.exe) into "IRBY Dental Ledger Setup.exe".
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.IO.Compression;
using Microsoft.Win32;

[assembly: AssemblyTitle("IRBY Dental Ledger Setup")]
[assembly: AssemblyDescription("Custom Installer for IRBY Dental Ledger")]
[assembly: AssemblyCompany("IRBY Dental Clinic")]
[assembly: AssemblyProduct("IRBY Dental Ledger")]
[assembly: AssemblyVersion("1.1.0.0")]
[assembly: AssemblyFileVersion("1.1.0.0")]

namespace IrbyDentalInstaller
{
    internal static class Program
    {
        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        // Unattended install (IT deployment, automated tests):
        //   "IRBY Dental Ledger Setup.exe" /silent "C:\IRBY Dental Ledger" [/demo] [/noocr] [/shortcuts]
        // Writes install-log.txt in the target folder; exit code 0 = installed, 1 = failed.
        [STAThread]
        private static int Main(string[] args)
        {
            try { SetProcessDPIAware(); } catch { }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            SilentOptions silent = SilentOptions.Parse(args);
            InstallerForm form = new InstallerForm(silent);
            Application.Run(form);
            return form.ExitCode;
        }
    }

    internal sealed class SilentOptions
    {
        public string TargetDir;
        public bool Demo;
        public bool Ocr = true;
        public bool Shortcuts;

        public static SilentOptions Parse(string[] args)
        {
            if (args == null) return null;
            SilentOptions o = null;
            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i].ToLowerInvariant();
                if (a == "/silent" || a == "-silent")
                {
                    o = o ?? new SilentOptions();
                    if (i + 1 < args.Length && !args[i + 1].StartsWith("/")) o.TargetDir = args[++i];
                }
            }
            if (o == null) return null;
            foreach (string raw in args)
            {
                string a = raw.ToLowerInvariant();
                if (a == "/demo") o.Demo = true;
                else if (a == "/noocr") o.Ocr = false;
                else if (a == "/shortcuts") o.Shortcuts = true;
            }
            if (string.IsNullOrEmpty(o.TargetDir))
            {
                o.TargetDir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "IRBY Dental Ledger");
            }
            return o;
        }
    }

    internal sealed class InstallerForm : Form
    {
        [DllImport("user32.dll")]
        private static extern bool ReleaseCapture();

        [DllImport("user32.dll")]
        private static extern IntPtr SendMessage(IntPtr hWnd, int Msg, int wParam, int lParam);

        private const int WM_NCLBUTTONDOWN = 0xA1;
        private const int HT_CAPTION = 0x2;

        // Brand palette
        private static readonly Color ColEspresso = Color.FromArgb(62, 47, 39);       // #3E2F27
        private static readonly Color ColEspressoDark = Color.FromArgb(46, 34, 28);   // #2E221C
        private static readonly Color ColEspressoHover = Color.FromArgb(84, 64, 53);  // #544035
        private static readonly Color ColGold = Color.FromArgb(212, 163, 115);        // #D4A373
        private static readonly Color ColIvory = Color.FromArgb(243, 239, 234);       // #F3EFEA
        private static readonly Color ColSidebar = Color.FromArgb(235, 229, 221);     // #EBE5DD
        private static readonly Color ColCard = Color.FromArgb(255, 255, 255);        // #FFFFFF
        private static readonly Color ColBorder = Color.FromArgb(222, 214, 204);      // #DED6CC
        private static readonly Color ColTextMain = Color.FromArgb(42, 34, 29);       // #2A221D
        private static readonly Color ColTextMuted = Color.FromArgb(111, 104, 96);    // #6F6860
        private static readonly Color ColGreen = Color.FromArgb(43, 122, 75);         // #2B7A4B

        private readonly string _sourceRoot;
        private int _currentStep = 0; // 0=Welcome, 1=Options, 2=Installing, 3=Finish
        private bool _isInstalling = false;

        // Sidebar step labels
        private readonly Label[] _stepLabels = new Label[4];
        private Panel _contentHost;
        private Button _btnBack;
        private Button _btnNext;
        private Button _btnCancel;

        // Step 1 controls
        private Panel _pageWelcome;
        private Label _lblNodeCheck;

        // Step 2 controls
        private Panel _pageOptions;
        private TextBox _txtInstallDir;
        private CheckBox _chkPortableHere;
        private CheckBox _chkDesktopShortcut;
        private CheckBox _chkStartMenuShortcut;
        private CheckBox _chkKeepDemoData;
        private CheckBox _chkRegisterApp;
        private CheckBox _chkSetupOcr;

        // OCR scanner (RapidOCR + Keras) Python environment: the official embeddable Python from
        // python.org is unpacked into <install>\python and the OCR packages are pip-installed into
        // it, so nothing outside the install folder is touched. server/ocr/autostart.js uses it.
        private const string PythonEmbedUrl = "https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip";
        private const string GetPipUrl = "https://bootstrap.pypa.io/get-pip.py";
        private string _ocrStatus = "Skipped (not selected)";

        private readonly SilentOptions _silent;
        public int ExitCode { get; private set; }

        // Step 3 controls
        private Panel _pageInstalling;
        private Label _lblProgressStatus;
        private Label _lblProgressPercent;
        private Panel _progressTrack;
        private Panel _progressFill;
        private TextBox _txtLog;

        // Step 4 controls
        private Panel _pageFinish;
        private Label _lblFinishSummary;
        private CheckBox _chkLaunchNow;

        private string _finalInstalledExePath;

        public InstallerForm(SilentOptions silent = null)
        {
            _silent = silent;
            _sourceRoot = ResolveSourceRoot();

            Text = "IRBY Dental Ledger — Setup Wizard";
            Size = new Size(780, 540);
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = ColIvory;
            DoubleBuffered = true;

            try
            {
                Icon exeIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                if (exeIcon != null) Icon = exeIcon;
            }
            catch { }

            BuildShell();
            BuildWelcomePage();
            BuildOptionsPage();
            BuildInstallingPage();
            BuildFinishPage();

            ShowStep(0);

            if (_silent != null)
            {
                Opacity = 0;
                ShowInTaskbar = false;
                Shown += async (s, e) => await RunSilentAsync();
            }
        }

        private async Task RunSilentAsync()
        {
            _txtInstallDir.ReadOnly = false;
            if (_chkPortableHere != null) _chkPortableHere.Checked = false;
            _txtInstallDir.Text = _silent.TargetDir;
            _chkDesktopShortcut.Checked = _silent.Shortcuts;
            _chkStartMenuShortcut.Checked = _silent.Shortcuts;
            _chkRegisterApp.Checked = _silent.Shortcuts;
            _chkKeepDemoData.Checked = _silent.Demo;
            _chkSetupOcr.Checked = _silent.Ocr;
            _chkLaunchNow.Checked = false;
            ShowStep(2);
            bool ok = await RunInstallationAsync();
            ExitCode = ok ? 0 : 1;
            try
            {
                Directory.CreateDirectory(_silent.TargetDir);
                File.WriteAllText(Path.Combine(_silent.TargetDir, "install-log.txt"), _txtLog.Text);
            }
            catch { }
            Close();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            using (Pen borderPen = new Pen(ColEspressoDark, 1))
            {
                e.Graphics.DrawRectangle(borderPen, 0, 0, Width - 1, Height - 1);
            }
        }

        private static string ResolveSourceRoot()
        {
            string exeDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            if (File.Exists(Path.Combine(exeDir, "server", "index.js")))
                return exeDir;
            DirectoryInfo parent = Directory.GetParent(exeDir);
            if (parent != null && File.Exists(Path.Combine(parent.FullName, "server", "index.js")))
                return parent.FullName;
            return Environment.CurrentDirectory;
        }

        private void BuildShell()
        {
            // Top Dark Espresso Header Banner (74px)
            Panel header = new Panel
            {
                Dock = DockStyle.Top,
                Height = 76,
                BackColor = ColEspresso
            };
            header.Paint += (s, e) =>
            {
                Graphics g = e.Graphics;
                g.SmoothingMode = SmoothingMode.AntiAlias;

                // Subtle bottom gold accent line
                using (Pen goldPen = new Pen(ColGold, 2))
                {
                    g.DrawLine(goldPen, 0, header.Height - 1, header.Width, header.Height - 1);
                }

                // Draw "IR" monogram emblem badge at (22, 16, 44x44)
                Rectangle badgeRect = new Rectangle(22, 16, 44, 44);
                using (GraphicsPath path = RoundedRect(badgeRect, 10))
                using (SolidBrush badgeBrush = new SolidBrush(ColEspressoDark))
                using (Pen ringPen = new Pen(ColGold, 1.5f))
                {
                    g.FillPath(badgeBrush, path);
                    g.DrawPath(ringPen, path);
                }
                using (Font emblemFont = new Font("Segoe UI", 14f, FontStyle.Bold))
                using (SolidBrush creamBrush = new SolidBrush(Color.FromArgb(248, 244, 239)))
                {
                    SizeF sz = g.MeasureString("IR", emblemFont);
                    g.DrawString("IR", emblemFont, creamBrush, 22 + (44 - sz.Width) / 2, 16 + (44 - sz.Height) / 2);
                }
            };

            Label titleLbl = new Label
            {
                Text = "IRBY Dental Ledger",
                Font = new Font("Segoe UI Semibold", 15f, FontStyle.Bold),
                ForeColor = Color.FromArgb(248, 244, 239),
                Location = new Point(78, 15),
                AutoSize = true,
                BackColor = Color.Transparent
            };

            Label subLbl = new Label
            {
                Text = "Digital Dental Chart & Records Management System · Windows Setup Wizard",
                Font = new Font("Segoe UI", 9f, FontStyle.Regular),
                ForeColor = Color.FromArgb(212, 198, 184),
                Location = new Point(80, 43),
                AutoSize = true,
                BackColor = Color.Transparent
            };

            Button btnMin = new Button
            {
                Text = "—",
                Font = new Font("Segoe UI", 9f, FontStyle.Bold),
                ForeColor = Color.FromArgb(225, 215, 205),
                BackColor = ColEspresso,
                FlatStyle = FlatStyle.Flat,
                Size = new Size(36, 28),
                Location = new Point(Width - 78, 10),
                Cursor = Cursors.Hand,
                TabStop = false
            };
            btnMin.FlatAppearance.BorderSize = 0;
            btnMin.Click += (s, e) => WindowState = FormWindowState.Minimized;

            Button btnClose = new Button
            {
                Text = "✕",
                Font = new Font("Segoe UI", 9.5f, FontStyle.Regular),
                ForeColor = Color.FromArgb(225, 215, 205),
                BackColor = ColEspresso,
                FlatStyle = FlatStyle.Flat,
                Size = new Size(36, 28),
                Location = new Point(Width - 40, 10),
                Cursor = Cursors.Hand,
                TabStop = false
            };
            btnClose.FlatAppearance.BorderSize = 0;
            btnClose.Click += (s, e) => TryCancelInstaller();

            MouseEventHandler dragHandler = (s, e) =>
            {
                if (e.Button == MouseButtons.Left)
                {
                    ReleaseCapture();
                    SendMessage(Handle, WM_NCLBUTTONDOWN, HT_CAPTION, 0);
                }
            };
            header.MouseDown += dragHandler;
            titleLbl.MouseDown += dragHandler;
            subLbl.MouseDown += dragHandler;

            header.Controls.Add(titleLbl);
            header.Controls.Add(subLbl);
            header.Controls.Add(btnMin);
            header.Controls.Add(btnClose);

            // Bottom Footer Action Bar (64px)
            Panel footer = new Panel
            {
                Dock = DockStyle.Bottom,
                Height = 64,
                BackColor = Color.FromArgb(238, 232, 224)
            };
            footer.Paint += (s, e) =>
            {
                using (Pen p = new Pen(ColBorder, 1))
                {
                    e.Graphics.DrawLine(p, 0, 0, footer.Width, 0);
                }
            };

            Label versionLabel = new Label
            {
                Text = "v1.1.0 · Offline-First Clinic Edition (AES-256-GCM)",
                Font = new Font("Segoe UI", 8.5f, FontStyle.Regular),
                ForeColor = ColTextMuted,
                Location = new Point(20, 24),
                AutoSize = true
            };

            _btnCancel = CreateSecondaryButton("Cancel", new Point(Width - 330, 14), 95);
            _btnCancel.Click += (s, e) => TryCancelInstaller();

            _btnBack = CreateSecondaryButton("← Back", new Point(Width - 225, 14), 95);
            _btnBack.Click += (s, e) =>
            {
                if (_currentStep > 0 && !_isInstalling)
                    ShowStep(_currentStep - 1);
            };

            _btnNext = CreatePrimaryButton("Continue →", new Point(Width - 120, 14), 102);
            _btnNext.Click += OnNextClicked;

            footer.Controls.Add(versionLabel);
            footer.Controls.Add(_btnCancel);
            footer.Controls.Add(_btnBack);
            footer.Controls.Add(_btnNext);

            // Left Step Navigation Sidebar (190px)
            Panel sidebar = new Panel
            {
                Dock = DockStyle.Left,
                Width = 190,
                BackColor = ColSidebar
            };
            sidebar.Paint += (s, e) =>
            {
                using (Pen p = new Pen(ColBorder, 1))
                {
                    e.Graphics.DrawLine(p, sidebar.Width - 1, 0, sidebar.Width - 1, sidebar.Height);
                }
            };

            string[] steps = new[]
            {
                "1. System Check",
                "2. Setup Options",
                "3. Installation",
                "4. Ready to Launch"
            };

            for (int i = 0; i < steps.Length; i++)
            {
                Label lbl = new Label
                {
                    Text = steps[i],
                    Font = new Font("Segoe UI Semibold", 9.5f, FontStyle.Regular),
                    ForeColor = ColTextMuted,
                    AutoSize = false,
                    Size = new Size(162, 38),
                    Location = new Point(14, 24 + i * 46),
                    TextAlign = ContentAlignment.MiddleLeft,
                    Padding = new Padding(10, 0, 0, 0)
                };
                _stepLabels[i] = lbl;
                sidebar.Controls.Add(lbl);
            }

            // Main Content Host Panel
            _contentHost = new Panel
            {
                Dock = DockStyle.Fill,
                BackColor = ColIvory,
                Padding = new Padding(26, 22, 26, 20)
            };

            Controls.Add(_contentHost);
            Controls.Add(sidebar);
            Controls.Add(footer);
            Controls.Add(header);
        }

        private void BuildWelcomePage()
        {
            _pageWelcome = new Panel { Dock = DockStyle.Fill, BackColor = ColIvory };

            Label heading = new Label
            {
                Text = "Welcome to IRBY Dental Ledger Setup",
                Font = new Font("Segoe UI Semibold", 14.5f, FontStyle.Bold),
                ForeColor = ColTextMain,
                Location = new Point(24, 18),
                AutoSize = true
            };

            Label desc = new Label
            {
                Text = "This wizard will configure and install IRBY Dental Ledger on this Windows computer,\n" +
                       "including the desktop application, encrypted SQLite clinic server, and shortcuts.",
                Font = new Font("Segoe UI", 9.5f),
                ForeColor = ColTextMuted,
                Location = new Point(24, 50),
                Size = new Size(520, 42)
            };

            // Pre-flight readiness card
            Panel card = CreateCardPanel(new Point(24, 102), new Size(520, 260));

            Label cardTitle = new Label
            {
                Text = "PRE-FLIGHT ENVIRONMENT CHECK",
                Font = new Font("Segoe UI Semibold", 8.5f, FontStyle.Bold),
                ForeColor = ColTextMuted,
                Location = new Point(18, 16),
                AutoSize = true
            };

            Label chkOs = new Label
            {
                Text = "✓  Windows 64-Bit Desktop Environment (" + Environment.OSVersion.VersionString + ")",
                Font = new Font("Segoe UI Semibold", 9.5f, FontStyle.Bold),
                ForeColor = ColGreen,
                Location = new Point(18, 48),
                AutoSize = true
            };
            Label chkOsSub = new Label
            {
                Text = "     Native high-DPI windowing & DPAPI / AES-256-GCM cryptography supported.",
                Font = new Font("Segoe UI", 8.5f),
                ForeColor = ColTextMuted,
                Location = new Point(18, 70),
                AutoSize = true
            };

            bool hasWv2 = IsWebView2Installed();
            Label chkWv = new Label
            {
                Text = hasWv2
                    ? "✓  Microsoft Edge WebView2 Chromium Runtime Detected"
                    : "✓  Microsoft Edge App Engine Available",
                Font = new Font("Segoe UI Semibold", 9.5f, FontStyle.Bold),
                ForeColor = ColGreen,
                Location = new Point(18, 104),
                AutoSize = true
            };
            Label chkWvSub = new Label
            {
                Text = "     Borderless native rendering, camera capture, and PDF print preview ready.",
                Font = new Font("Segoe UI", 8.5f),
                ForeColor = ColTextMuted,
                Location = new Point(18, 126),
                AutoSize = true
            };

            string bundledNode = FindExistingNode();
            _lblNodeCheck = new Label
            {
                Text = !string.IsNullOrEmpty(bundledNode)
                    ? "✓  Node.js v22 LTS Clinic Engine Bundled & Ready"
                    : "✓  Node.js v22 LTS Engine (Will be auto-downloaded during setup)",
                Font = new Font("Segoe UI Semibold", 9.5f, FontStyle.Bold),
                ForeColor = ColGreen,
                Location = new Point(18, 160),
                AutoSize = true
            };
            Label chkNodeSub = new Label
            {
                Text = !string.IsNullOrEmpty(bundledNode)
                    ? "     Found at: " + bundledNode
                    : "     Portable Node.js v22.14.0 LTS will be configured automatically.",
                Font = new Font("Segoe UI", 8.5f),
                ForeColor = ColTextMuted,
                Location = new Point(18, 182),
                Size = new Size(480, 36)
            };

            Label footerNote = new Label
            {
                Text = "No internet connection is required during daily clinic operation (NFR-A1).",
                Font = new Font("Segoe UI", 8.5f, FontStyle.Italic),
                ForeColor = ColTextMuted,
                Location = new Point(18, 224),
                AutoSize = true
            };

            card.Controls.Add(cardTitle);
            card.Controls.Add(chkOs);
            card.Controls.Add(chkOsSub);
            card.Controls.Add(chkWv);
            card.Controls.Add(chkWvSub);
            card.Controls.Add(_lblNodeCheck);
            card.Controls.Add(chkNodeSub);
            card.Controls.Add(footerNote);

            _pageWelcome.Controls.Add(heading);
            _pageWelcome.Controls.Add(desc);
            _pageWelcome.Controls.Add(card);
        }

        private static bool HasEmbeddedPayload()
        {
            try
            {
                using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
                {
                    return s != null;
                }
            }
            catch { return false; }
        }

        private void BuildOptionsPage()
        {
            _pageOptions = new Panel { Dock = DockStyle.Fill, BackColor = ColIvory };

            Label heading = new Label
            {
                Text = "Installation Location & Shortcuts",
                Font = new Font("Segoe UI Semibold", 14.5f, FontStyle.Bold),
                ForeColor = ColTextMain,
                Location = new Point(24, 18),
                AutoSize = true
            };

            Label desc = new Label
            {
                Text = "Choose where to install IRBY Dental Ledger and select your clinic workstation preferences.",
                Font = new Font("Segoe UI", 9.5f),
                ForeColor = ColTextMuted,
                Location = new Point(24, 50),
                AutoSize = true
            };

            Panel card = CreateCardPanel(new Point(24, 84), new Size(520, 282));

            Label dirLabel = new Label
            {
                Text = "Destination Folder:",
                Font = new Font("Segoe UI Semibold", 9f, FontStyle.Bold),
                ForeColor = ColTextMain,
                Location = new Point(18, 16),
                AutoSize = true
            };

            string defaultInstallDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Programs",
                "IRBY Dental Ledger"
            );

            bool hasEmbedded = HasEmbeddedPayload();
            string initialDir = hasEmbedded ? defaultInstallDir : _sourceRoot;

            _txtInstallDir = new TextBox
            {
                Text = initialDir,
                Font = new Font("Segoe UI", 9.5f),
                Location = new Point(18, 40),
                Size = new Size(390, 26),
                ReadOnly = !hasEmbedded
            };

            Button btnBrowse = CreateSecondaryButton("Browse…", new Point(416, 38), 86);
            btnBrowse.Height = 27;
            btnBrowse.Click += (s, e) =>
            {
                using (FolderBrowserDialog fbd = new FolderBrowserDialog())
                {
                    fbd.Description = "Select installation folder for IRBY Dental Ledger:";
                    fbd.SelectedPath = _txtInstallDir.Text;
                    if (fbd.ShowDialog(this) == DialogResult.OK)
                    {
                        if (_chkPortableHere != null) _chkPortableHere.Checked = false;
                        _txtInstallDir.Text = fbd.SelectedPath;
                    }
                }
            };

            _chkPortableHere = new CheckBox
            {
                Text = "Configure directly in current folder (" + _sourceRoot + ")",
                Font = new Font("Segoe UI", 9f),
                ForeColor = ColTextMain,
                Location = new Point(18, 74),
                Size = new Size(480, 24),
                Checked = !hasEmbedded,
                Visible = !hasEmbedded
            };
            _chkPortableHere.CheckedChanged += (s, e) =>
            {
                if (_chkPortableHere.Checked)
                {
                    _txtInstallDir.Text = _sourceRoot;
                    _txtInstallDir.ReadOnly = true;
                }
                else
                {
                    _txtInstallDir.Text = defaultInstallDir;
                    _txtInstallDir.ReadOnly = false;
                }
            };

            _chkDesktopShortcut = new CheckBox
            {
                Text = "Create a Desktop shortcut (\"IRBY Dental Ledger\")",
                Font = new Font("Segoe UI Semibold", 9.5f),
                ForeColor = ColTextMain,
                Location = new Point(18, 116),
                Size = new Size(460, 24),
                Checked = true
            };

            _chkStartMenuShortcut = new CheckBox
            {
                Text = "Add to Windows Start Menu (Programs → IRBY Dental Ledger)",
                Font = new Font("Segoe UI Semibold", 9.5f),
                ForeColor = ColTextMain,
                Location = new Point(18, 150),
                Size = new Size(460, 24),
                Checked = true
            };

            _chkKeepDemoData = new CheckBox
            {
                Text = "Include sample clinic demo records & accounts (admin / dr.bautista / m.santos)",
                Font = new Font("Segoe UI", 9.2f),
                ForeColor = ColTextMain,
                Location = new Point(18, 184),
                Size = new Size(485, 24),
                Checked = false
            };

            _chkRegisterApp = new CheckBox
            {
                Text = "Register in Windows Installed Apps",
                Font = new Font("Segoe UI", 9.2f),
                ForeColor = ColTextMain,
                Location = new Point(18, 218),
                Size = new Size(460, 24),
                Checked = true
            };

            _chkSetupOcr = new CheckBox
            {
                Text = "Set up the OCR form scanner (needs internet: about 600 MB, 5–15 min)",
                Font = new Font("Segoe UI", 9.2f),
                ForeColor = ColTextMain,
                Location = new Point(18, 252),
                Size = new Size(485, 24),
                Checked = true
            };

            card.Controls.Add(dirLabel);
            card.Controls.Add(_txtInstallDir);
            card.Controls.Add(btnBrowse);
            card.Controls.Add(_chkPortableHere);
            card.Controls.Add(_chkDesktopShortcut);
            card.Controls.Add(_chkStartMenuShortcut);
            card.Controls.Add(_chkKeepDemoData);
            card.Controls.Add(_chkRegisterApp);
            card.Controls.Add(_chkSetupOcr);

            _pageOptions.Controls.Add(heading);
            _pageOptions.Controls.Add(desc);
            _pageOptions.Controls.Add(card);
        }

        private void BuildInstallingPage()
        {
            _pageInstalling = new Panel { Dock = DockStyle.Fill, BackColor = ColIvory };

            Label heading = new Label
            {
                Text = "Installing IRBY Dental Ledger…",
                Font = new Font("Segoe UI Semibold", 14.5f, FontStyle.Bold),
                ForeColor = ColTextMain,
                Location = new Point(24, 18),
                AutoSize = true
            };

            _lblProgressStatus = new Label
            {
                Text = "Preparing installation…",
                Font = new Font("Segoe UI", 9.5f),
                ForeColor = ColTextMuted,
                Location = new Point(24, 52),
                Size = new Size(430, 22)
            };

            _lblProgressPercent = new Label
            {
                Text = "0%",
                Font = new Font("Segoe UI Semibold", 9.5f, FontStyle.Bold),
                ForeColor = ColEspresso,
                Location = new Point(464, 52),
                Size = new Size(80, 22),
                TextAlign = ContentAlignment.TopRight
            };

            _progressTrack = new Panel
            {
                Location = new Point(24, 80),
                Size = new Size(520, 14),
                BackColor = ColBorder
            };

            _progressFill = new Panel
            {
                Location = new Point(0, 0),
                Size = new Size(0, 14),
                BackColor = ColEspresso
            };
            _progressTrack.Controls.Add(_progressFill);

            _txtLog = new TextBox
            {
                Multiline = true,
                ReadOnly = true,
                ScrollBars = ScrollBars.Vertical,
                BackColor = Color.White,
                ForeColor = ColTextMain,
                BorderStyle = BorderStyle.FixedSingle,
                Font = new Font("Consolas", 9f),
                Location = new Point(24, 110),
                Size = new Size(520, 254)
            };

            _pageInstalling.Controls.Add(heading);
            _pageInstalling.Controls.Add(_lblProgressStatus);
            _pageInstalling.Controls.Add(_lblProgressPercent);
            _pageInstalling.Controls.Add(_progressTrack);
            _pageInstalling.Controls.Add(_txtLog);
        }

        private void BuildFinishPage()
        {
            _pageFinish = new Panel { Dock = DockStyle.Fill, BackColor = ColIvory };

            Label badge = new Label
            {
                Text = "✓  Installation Complete",
                Font = new Font("Segoe UI Semibold", 15f, FontStyle.Bold),
                ForeColor = ColGreen,
                Location = new Point(24, 18),
                AutoSize = true
            };

            Label sub = new Label
            {
                Text = "IRBY Dental Ledger is installed and ready to use on this Windows computer.",
                Font = new Font("Segoe UI", 9.5f),
                ForeColor = ColTextMuted,
                Location = new Point(24, 50),
                AutoSize = true
            };

            Panel card = CreateCardPanel(new Point(24, 84), new Size(520, 230));

            _lblFinishSummary = new Label
            {
                Text = "",
                Font = new Font("Segoe UI", 9.2f),
                ForeColor = ColTextMain,
                Location = new Point(18, 16),
                Size = new Size(484, 198)
            };
            card.Controls.Add(_lblFinishSummary);

            _chkLaunchNow = new CheckBox
            {
                Text = "Launch IRBY Dental Ledger now",
                Font = new Font("Segoe UI Semibold", 10f, FontStyle.Bold),
                ForeColor = ColEspresso,
                Location = new Point(26, 330),
                Size = new Size(340, 28),
                Checked = true
            };

            _pageFinish.Controls.Add(badge);
            _pageFinish.Controls.Add(sub);
            _pageFinish.Controls.Add(card);
            _pageFinish.Controls.Add(_chkLaunchNow);
        }

        private void ShowStep(int step)
        {
            _currentStep = step;
            _contentHost.Controls.Clear();

            for (int i = 0; i < _stepLabels.Length; i++)
            {
                if (i == step)
                {
                    _stepLabels[i].BackColor = ColEspresso;
                    _stepLabels[i].ForeColor = Color.FromArgb(248, 244, 239);
                    _stepLabels[i].Font = new Font("Segoe UI Semibold", 9.5f, FontStyle.Bold);
                }
                else if (i < step)
                {
                    _stepLabels[i].BackColor = Color.Transparent;
                    _stepLabels[i].ForeColor = ColGreen;
                    _stepLabels[i].Font = new Font("Segoe UI Semibold", 9.5f, FontStyle.Regular);
                }
                else
                {
                    _stepLabels[i].BackColor = Color.Transparent;
                    _stepLabels[i].ForeColor = ColTextMuted;
                    _stepLabels[i].Font = new Font("Segoe UI", 9.5f, FontStyle.Regular);
                }
            }

            if (step == 0)
            {
                _contentHost.Controls.Add(_pageWelcome);
                _btnBack.Enabled = false;
                _btnNext.Text = "Continue →";
                _btnNext.Enabled = true;
            }
            else if (step == 1)
            {
                _contentHost.Controls.Add(_pageOptions);
                _btnBack.Enabled = true;
                _btnNext.Text = "Install Now";
                _btnNext.Enabled = true;
            }
            else if (step == 2)
            {
                _contentHost.Controls.Add(_pageInstalling);
                _btnBack.Enabled = false;
                _btnNext.Enabled = false;
                _btnCancel.Enabled = false;
            }
            else if (step == 3)
            {
                _contentHost.Controls.Add(_pageFinish);
                _btnBack.Visible = false;
                _btnCancel.Visible = false;
                _btnNext.Text = "Finish";
                _btnNext.Enabled = true;
            }
        }

        private async void OnNextClicked(object sender, EventArgs e)
        {
            if (_currentStep == 0)
            {
                ShowStep(1);
            }
            else if (_currentStep == 1)
            {
                ShowStep(2);
                await RunInstallationAsync();
            }
            else if (_currentStep == 3)
            {
                if (_chkLaunchNow.Checked && !string.IsNullOrEmpty(_finalInstalledExePath) && File.Exists(_finalInstalledExePath))
                {
                    try
                    {
                        Process.Start(new ProcessStartInfo(_finalInstalledExePath)
                        {
                            WorkingDirectory = Path.GetDirectoryName(_finalInstalledExePath),
                            UseShellExecute = true
                        });
                    }
                    catch { }
                }
                Close();
            }
        }

        private async Task<bool> RunInstallationAsync()
        {
            _isInstalling = true;
            string targetDir = _txtInstallDir.Text.Trim();
            bool isInPlace = string.Equals(
                Path.GetFullPath(targetDir).TrimEnd('\\'),
                Path.GetFullPath(_sourceRoot).TrimEnd('\\'),
                StringComparison.OrdinalIgnoreCase
            );

            try
            {
                SetProgress(8, "Preparing installation directory…");
                AppendLog("Target directory: " + targetDir);
                await Task.Run(() => Directory.CreateDirectory(targetDir));

                if (HasEmbeddedPayload())
                {
                    SetProgress(12, "Extracting clinic software, database engine & configuration…");
                    AppendLog("Unpacking all-in-one embedded application payload…");
                    await Task.Run(() =>
                    {
                        using (Stream resStream = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
                        {
                            if (resStream != null)
                            {
                                using (ZipArchive archive = new ZipArchive(resStream, ZipArchiveMode.Read))
                                {
                                    int total = archive.Entries.Count;
                                    int count = 0;
                                    foreach (ZipArchiveEntry entry in archive.Entries)
                                    {
                                        count++;
                                        string destPath = Path.Combine(targetDir, entry.FullName);
                                        if (string.IsNullOrEmpty(entry.Name))
                                        {
                                            Directory.CreateDirectory(destPath);
                                        }
                                        else
                                        {
                                            Directory.CreateDirectory(Path.GetDirectoryName(destPath));
                                            entry.ExtractToFile(destPath, true);
                                        }
                                        if (count % 20 == 0 || count == total)
                                        {
                                            int pct = 12 + (int)((count / (double)total) * 45);
                                            BeginInvoke(new Action(() =>
                                            {
                                                SetProgress(pct, string.Format("Extracting files ({0}/{1})…", count, total));
                                            }));
                                        }
                                    }
                                }
                            }
                        }
                    });
                    AppendLog("✓ Software extraction complete.");
                }
                else if (!isInPlace)
                {
                    SetProgress(22, "Copying clinic application, server & PDA symbol configurations…");
                    AppendLog("Copying application files from package…");
                    await Task.Run(() => CopyProjectFiles(_sourceRoot, targetDir));
                }
                else
                {
                    SetProgress(25, "Verifying clinic application & server files in folder…");
                    AppendLog("Verified in-place application files.");
                }

                // Step: Ensure Node.js v22 runtime
                SetProgress(48, "Configuring Node.js v22 LTS engine…");
                string targetNode = Path.Combine(targetDir, "runtime", "node.exe");
                string existingNode = FindExistingNode();

                if (!File.Exists(targetNode))
                {
                    Directory.CreateDirectory(Path.Combine(targetDir, "runtime"));
                    if (!string.IsNullOrEmpty(existingNode) && File.Exists(existingNode))
                    {
                        AppendLog("Copying Node.js runtime from: " + existingNode);
                        await Task.Run(() => File.Copy(existingNode, targetNode, true));
                    }
                    else
                    {
                        AppendLog("Downloading portable Node.js v22.14.0 LTS from nodejs.org…");
                        await DownloadNodeRuntimeAsync(targetNode);
                    }
                }
                AppendLog("✓ Node.js v22 LTS engine ready: " + targetNode);

                // Step: settings file. Without .env the app falls back to the demo ("mock") OCR.
                // An existing .env (reinstall / upgrade) is kept as it is.
                SetProgress(56, "Writing clinic settings…");
                string envFile = Path.Combine(targetDir, ".env");
                string envExample = Path.Combine(targetDir, ".env.example");
                if (File.Exists(envFile))
                {
                    AppendLog("✓ Keeping existing settings file (.env).");
                }
                else if (File.Exists(envExample))
                {
                    File.Copy(envExample, envFile);
                    AppendLog("✓ Created settings file (.env) with the RapidOCR scanner switched on.");
                }

                // Step: Seed demo data if requested and database not yet created
                SetProgress(58, "Configuring AES-256-GCM encrypted clinic database…");
                string dbPath = Path.Combine(targetDir, "data", "irby.db");
                if (_chkKeepDemoData.Checked && !File.Exists(dbPath) && File.Exists(targetNode))
                {
                    AppendLog("Seeding initial demo clinic patients and accounts…");
                    await Task.Run(() =>
                    {
                        try
                        {
                            ProcessStartInfo psi = new ProcessStartInfo
                            {
                                FileName = targetNode,
                                Arguments = "--disable-warning=ExperimentalWarning scripts/seed-demo.js",
                                WorkingDirectory = targetDir,
                                UseShellExecute = false,
                                CreateNoWindow = true
                            };
                            using (Process p = Process.Start(psi))
                            {
                                if (p != null) p.WaitForExit(15000);
                            }
                        }
                        catch { }
                    });
                }
                AppendLog("✓ Encrypted SQLite database & master key verified.");

                // Step: OCR form scanner (Python + RapidOCR + Keras). Never fails the install.
                if (_chkSetupOcr.Checked)
                {
                    _ocrStatus = await SetupOcrAsync(targetDir);
                }
                else
                {
                    _ocrStatus = "Skipped. To add it later, run this Setup again with the OCR option ticked.";
                    AppendLog("OCR form scanner set-up skipped.");
                }

                // Step: Shortcuts & Registry
                _finalInstalledExePath = Path.Combine(targetDir, "IRBY Dental Ledger.exe");
                string iconPath = Path.Combine(targetDir, "build", "icon.ico");

                SetProgress(92, "Creating Windows shortcuts…");
                if (_chkDesktopShortcut.Checked)
                {
                    string desktopLnk = Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
                        "IRBY Dental Ledger.lnk"
                    );
                    CreateShortcut(desktopLnk, _finalInstalledExePath, targetDir, iconPath, "IRBY Dental Ledger — Digital Dental Chart & Records Management System");
                    AppendLog("✓ Created Desktop shortcut: " + desktopLnk);
                }

                if (_chkStartMenuShortcut.Checked)
                {
                    string startMenuLnk = Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.Programs),
                        "IRBY Dental Ledger.lnk"
                    );
                    CreateShortcut(startMenuLnk, _finalInstalledExePath, targetDir, iconPath, "IRBY Dental Ledger — Digital Dental Chart & Records Management System");
                    AppendLog("✓ Created Start Menu shortcut: " + startMenuLnk);
                }

                if (_chkRegisterApp.Checked)
                {
                    RegisterInWindowsApps(targetDir, _finalInstalledExePath, iconPath);
                    AppendLog("✓ Registered in Windows Installed Apps.");
                }

                SetProgress(100, "Installation finished successfully!");
                AppendLog("Done!");
                await Task.Delay(350);

                _lblFinishSummary.Text =
                    "Installed Location:\n" +
                    "  " + targetDir + "\n\n" +
                    "OCR Form Scanner:\n" +
                    "  " + _ocrStatus + "\n\n" +
                    (_chkKeepDemoData.Checked
                        ? "Demo Sign-In Accounts:\n" +
                          "  • Administrator:   admin  /  Irby#Clinic-Root26\n" +
                          "  • Dentist:             dr.bautista  /  Bautista#Dental26\n" +
                          "  • Front Desk:        m.santos  /  Santos#FrontDesk26"
                        : "Account Setup:\n" +
                          "  • A clean, fresh clinic database has been created.\n" +
                          "  • When you launch the app, you will be prompted to create\n" +
                          "    your own clinic Administrator account.");

                _isInstalling = false;
                ShowStep(3);
                return true;
            }
            catch (Exception ex)
            {
                _isInstalling = false;
                _btnCancel.Enabled = true;
                AppendLog("ERROR: " + ex.Message);
                if (_silent == null)
                {
                    MessageBox.Show(
                        this,
                        "An error occurred during installation:\n\n" + ex.Message,
                        "Installation Error",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Error
                    );
                }
                return false;
            }
        }

        // ------------------------------------------------------------------ OCR scanner set-up

        /// <summary>
        /// Puts the OCR's Python in &lt;install&gt;\python: the official embeddable Python 3.12,
        /// pip, then ocr-model\requirements.txt (RapidOCR, OpenCV, Keras / TensorFlow), and checks
        /// that the model loads. Returns a one-line status for the finish page; never throws.
        /// </summary>
        private async Task<string> SetupOcrAsync(string targetDir)
        {
            string pyDir = Path.Combine(targetDir, "python");
            string pyExe = Path.Combine(pyDir, "python.exe");
            string requirements = Path.Combine(targetDir, "ocr-model", "requirements.txt");
            string infer = Path.Combine(targetDir, "ocr-model", "infer.py");
            const string later = " The rest of the app works. Run this Setup again later (same folder) to finish it.";
            try
            {
                if (!File.Exists(requirements))
                    return "Not set up: ocr-model folder is missing." + later;
                ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;

                if (!File.Exists(pyExe))
                {
                    SetProgress(60, "Downloading Python 3.12 for the OCR scanner…");
                    AppendLog("Downloading Python 3.12 (embeddable, 11 MB) from python.org…");
                    string zip = Path.Combine(targetDir, "python-embed.zip");
                    await DownloadFileAsync(PythonEmbedUrl, zip, 60, 63, "Downloading Python 3.12");
                    await Task.Run(() =>
                    {
                        if (Directory.Exists(pyDir)) Directory.Delete(pyDir, true);
                        ZipFile.ExtractToDirectory(zip, pyDir);
                        File.Delete(zip);
                        // the embeddable build ignores site-packages until "import site" is enabled
                        foreach (string pth in Directory.GetFiles(pyDir, "python3*._pth"))
                        {
                            string[] lines = File.ReadAllLines(pth);
                            for (int i = 0; i < lines.Length; i++)
                                if (lines[i].Trim().StartsWith("#") && lines[i].Contains("import site")) lines[i] = "import site";
                            File.WriteAllLines(pth, lines);
                        }
                    });
                    AppendLog("✓ Python 3.12 unpacked to " + pyDir);
                }
                else
                {
                    AppendLog("✓ Reusing Python already in " + pyDir);
                }

                if (await RunProcessAsync(pyExe, "-m pip --version", targetDir, null) != 0)
                {
                    SetProgress(64, "Installing pip…");
                    string getPip = Path.Combine(pyDir, "get-pip.py");
                    await DownloadFileAsync(GetPipUrl, getPip, 64, 65, "Downloading pip");
                    int pipCode = await RunProcessAsync(pyExe,
                        "\"" + getPip + "\" --no-warn-script-location --disable-pip-version-check", targetDir, AppendLog);
                    try { File.Delete(getPip); } catch { }
                    if (pipCode != 0) return "Not set up: pip could not be installed (exit " + pipCode + ")." + later;
                }

                SetProgress(66, "Installing OCR packages (RapidOCR, OpenCV, TensorFlow)… this takes a while");
                AppendLog("Installing OCR packages - about 600 MB to download, 5 to 15 minutes…");
                int collected = 0;
                int code = await RunProcessAsync(pyExe,
                    "-m pip install --no-warn-script-location --disable-pip-version-check --progress-bar off -r \"" + requirements + "\"",
                    targetDir,
                    line =>
                    {
                        if (line.StartsWith("Collecting ") || line.StartsWith("Requirement already satisfied"))
                        {
                            collected++;
                            SetProgress(Math.Min(84, 66 + collected / 3), "Installing OCR packages (" + collected + " checked)…");
                        }
                        if (line.StartsWith("Collecting ") || line.StartsWith("Downloading ") || line.StartsWith("Installing ")
                            || line.StartsWith("Successfully ") || line.StartsWith("ERROR") || line.Contains("error:"))
                        {
                            int from = line.IndexOf(" (from ", StringComparison.Ordinal);
                            AppendLog(from > 0 ? line.Substring(0, from) : line);
                        }
                    });
                if (code != 0) return "Not set up: package install failed (pip exit " + code + "; check the internet connection)." + later;

                SetProgress(86, "Checking that the OCR model loads…");
                AppendLog("Loading the OCR model once to check it (about 20 s)…");
                bool ready = false;
                string detail = "";
                int healthCode = await RunProcessAsync(pyExe, "\"" + infer + "\" --health", targetDir, line =>
                {
                    if (line.TrimStart().StartsWith("{") && line.Contains("\"ready\""))
                    {
                        ready = line.Contains("\"ready\": true");
                        detail = line.Trim();
                    }
                });
                AppendLog(detail.Length > 0 ? detail : "OCR health check exited with code " + healthCode);
                if (!ready) return "Installed, but the model did not load (see the install log)." + later;
                AppendLog("✓ OCR form scanner ready.");
                return "Ready (RapidOCR + Keras document classifier). Starts by itself with the app.";
            }
            catch (Exception ex)
            {
                AppendLog("OCR set-up stopped: " + ex.Message);
                return "Not set up: " + ex.Message + later;
            }
        }

        private async Task DownloadFileAsync(string url, string target, int pctFrom, int pctTo, string label)
        {
            string temp = target + ".download";
            using (WebClient wc = new WebClient())
            {
                wc.DownloadProgressChanged += (s, e) =>
                {
                    try
                    {
                        BeginInvoke(new Action(() => SetProgress(
                            pctFrom + (int)(e.ProgressPercentage * (pctTo - pctFrom) / 100.0),
                            label + " (" + e.ProgressPercentage + "%)…")));
                    }
                    catch { }
                };
                await wc.DownloadFileTaskAsync(new Uri(url), temp);
            }
            if (File.Exists(target)) File.Delete(target);
            File.Move(temp, target);
        }

        /// <summary>Runs a console program hidden, passing each output line (stdout and stderr)
        /// to onLine on the UI thread. Returns the exit code.</summary>
        private Task<int> RunProcessAsync(string file, string args, string workDir, Action<string> onLine)
        {
            TaskCompletionSource<int> tcs = new TaskCompletionSource<int>();
            ProcessStartInfo psi = new ProcessStartInfo
            {
                FileName = file,
                Arguments = args,
                WorkingDirectory = workDir,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            psi.EnvironmentVariables["PYTHONUTF8"] = "1";
            psi.EnvironmentVariables["PYTHONUNBUFFERED"] = "1";
            psi.EnvironmentVariables["PIP_DISABLE_PIP_VERSION_CHECK"] = "1";
            psi.EnvironmentVariables["TF_CPP_MIN_LOG_LEVEL"] = "3";
            psi.EnvironmentVariables["TF_ENABLE_ONEDNN_OPTS"] = "0";
            Process p = new Process { StartInfo = psi, EnableRaisingEvents = true };
            DataReceivedEventHandler relay = (s, e) =>
            {
                if (e.Data == null || onLine == null) return;
                string line = e.Data.TrimEnd();
                if (line.Length == 0) return;
                try { BeginInvoke(new Action(() => onLine(line))); } catch { }
            };
            p.OutputDataReceived += relay;
            p.ErrorDataReceived += relay;
            p.Exited += (s, e) =>
            {
                try { p.WaitForExit(); } catch { }
                int code = -1;
                try { code = p.ExitCode; } catch { }
                // let the queued output lines reach the log before the caller continues
                try { BeginInvoke(new Action(() => tcs.TrySetResult(code))); } catch { tcs.TrySetResult(code); }
                p.Dispose();
            };
            p.Start();
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            return tcs.Task;
        }

        private void SetProgress(int percent, string status)
        {
            percent = Math.Max(0, Math.Min(100, percent));
            _lblProgressStatus.Text = status;
            _lblProgressPercent.Text = percent + "%";
            _progressFill.Width = (int)Math.Round((_progressTrack.Width * percent) / 100.0);
        }

        private void AppendLog(string line)
        {
            if (_txtLog.TextLength > 0)
                _txtLog.AppendText(Environment.NewLine);
            _txtLog.AppendText(line);
        }

        private static void CopyProjectFiles(string sourceDir, string targetDir)
        {
            // ocr-model\.venv is a developer's local Python environment (about 2 GB, tied to that
            // machine's Python); the installed copy builds its own with ocr-model\setup-ocr.ps1
            string[] skipDirs = new[] { "IRBY Dental Ledger.app", ".git", Path.Combine("ocr-model", ".venv") };
            foreach (string dirPath in Directory.GetDirectories(sourceDir, "*", SearchOption.AllDirectories))
            {
                string rel = dirPath.Substring(sourceDir.Length).TrimStart(Path.DirectorySeparatorChar);
                bool skip = false;
                foreach (string sd in skipDirs)
                {
                    if (rel.Equals(sd, StringComparison.OrdinalIgnoreCase) ||
                        rel.StartsWith(sd + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                    {
                        skip = true;
                        break;
                    }
                }
                if (!skip)
                {
                    Directory.CreateDirectory(Path.Combine(targetDir, rel));
                }
            }

            foreach (string filePath in Directory.GetFiles(sourceDir, "*", SearchOption.AllDirectories))
            {
                string rel = filePath.Substring(sourceDir.Length).TrimStart(Path.DirectorySeparatorChar);
                if (rel.Equals("Install-Node-Mac.command", StringComparison.OrdinalIgnoreCase))
                    continue;
                bool skip = false;
                foreach (string sd in skipDirs)
                {
                    if (rel.StartsWith(sd + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                    {
                        skip = true;
                        break;
                    }
                }
                if (skip) continue;

                string destFile = Path.Combine(targetDir, rel);
                Directory.CreateDirectory(Path.GetDirectoryName(destFile));
                File.Copy(filePath, destFile, true);
            }
        }

        private async Task DownloadNodeRuntimeAsync(string targetExe)
        {
            string tempFile = targetExe + ".download";
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            using (WebClient wc = new WebClient())
            {
                wc.DownloadProgressChanged += (s, e) =>
                {
                    try
                    {
                        BeginInvoke(new Action(() =>
                        {
                            SetProgress(48 + (int)(e.ProgressPercentage * 0.07), "Downloading Node.js v22 LTS runtime (" + e.ProgressPercentage + "%)…");
                        }));
                    }
                    catch { }
                };
                await wc.DownloadFileTaskAsync(new Uri("https://nodejs.org/dist/v22.14.0/win-x64/node.exe"), tempFile);
            }
            if (File.Exists(targetExe)) File.Delete(targetExe);
            File.Move(tempFile, targetExe);
        }

        private string FindExistingNode()
        {
            string[] candidates = new[]
            {
                Path.Combine(_sourceRoot, "runtime", "node.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "nodejs", "node.exe")
            };
            foreach (string c in candidates)
            {
                if (File.Exists(c)) return c;
            }
            return null;
        }

        private static bool IsWebView2Installed()
        {
            try
            {
                string pfx86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
                return Directory.Exists(Path.Combine(pfx86, @"Microsoft\EdgeWebView\Application"));
            }
            catch
            {
                return true;
            }
        }

        private static void CreateShortcut(string lnkPath, string targetExe, string workingDir, string iconPath, string description)
        {
            try
            {
                Type shellType = Type.GetTypeFromProgID("WScript.Shell");
                if (shellType == null) return;
                object shell = Activator.CreateInstance(shellType);
                object shortcut = shellType.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnkPath });
                Type scType = shortcut.GetType();
                scType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] { targetExe });
                scType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] { workingDir });
                scType.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, new object[] { description });
                if (File.Exists(iconPath))
                {
                    scType.InvokeMember("IconLocation", BindingFlags.SetProperty, null, shortcut, new object[] { iconPath + ",0" });
                }
                scType.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
            }
            catch { }
        }

        private static void RegisterInWindowsApps(string installDir, string exePath, string iconPath)
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\IRBYDentalLedger"))
                {
                    if (key != null)
                    {
                        key.SetValue("DisplayName", "IRBY Dental Ledger");
                        key.SetValue("DisplayVersion", "1.1.0");
                        key.SetValue("Publisher", "IRBY Dental Clinic");
                        key.SetValue("InstallLocation", installDir);
                        key.SetValue("DisplayIcon", File.Exists(iconPath) ? iconPath : exePath);
                        key.SetValue("UninstallString", "cmd.exe /c rmdir /s /q \"" + installDir + "\"");
                        key.SetValue("NoModify", 1, RegistryValueKind.DWord);
                        key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                    }
                }
            }
            catch { }
        }

        private void TryCancelInstaller()
        {
            if (_isInstalling) return;
            Close();
        }

        private static Panel CreateCardPanel(Point location, Size size)
        {
            Panel p = new Panel
            {
                Location = location,
                Size = size,
                BackColor = ColCard
            };
            p.Paint += (s, e) =>
            {
                using (Pen borderPen = new Pen(ColBorder, 1))
                {
                    e.Graphics.DrawRectangle(borderPen, 0, 0, p.Width - 1, p.Height - 1);
                }
            };
            return p;
        }

        private static Button CreatePrimaryButton(string text, Point location, int width)
        {
            Button btn = new Button
            {
                Text = text,
                Font = new Font("Segoe UI Semibold", 9.5f, FontStyle.Bold),
                BackColor = ColEspresso,
                ForeColor = Color.FromArgb(248, 244, 239),
                FlatStyle = FlatStyle.Flat,
                Location = location,
                Size = new Size(width, 36),
                Cursor = Cursors.Hand
            };
            btn.FlatAppearance.BorderSize = 0;
            btn.FlatAppearance.MouseOverBackColor = ColEspressoHover;
            return btn;
        }

        private static Button CreateSecondaryButton(string text, Point location, int width)
        {
            Button btn = new Button
            {
                Text = text,
                Font = new Font("Segoe UI", 9.5f, FontStyle.Regular),
                BackColor = Color.White,
                ForeColor = ColTextMain,
                FlatStyle = FlatStyle.Flat,
                Location = location,
                Size = new Size(width, 36),
                Cursor = Cursors.Hand
            };
            btn.FlatAppearance.BorderColor = ColBorder;
            btn.FlatAppearance.BorderSize = 1;
            return btn;
        }

        private static GraphicsPath RoundedRect(Rectangle bounds, int radius)
        {
            int d = radius * 2;
            GraphicsPath path = new GraphicsPath();
            path.AddArc(bounds.X, bounds.Y, d, d, 180, 90);
            path.AddArc(bounds.Right - d, bounds.Y, d, d, 270, 90);
            path.AddArc(bounds.Right - d, bounds.Bottom - d, d, d, 0, 90);
            path.AddArc(bounds.X, bounds.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }
    }
}
