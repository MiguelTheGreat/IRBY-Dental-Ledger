package com.irbyclinic.dentalledger;

import android.Manifest;
import android.content.Context;
import android.content.DialogInterface;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.Toast;

import androidx.annotation.NonNull;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

public class MainActivity extends AppCompatActivity {

    private static final String PREFS_NAME = "IRBYPrefs";
    private static final String KEY_SERVER_URL = "ServerUrl";
    private static final int REQ_CAMERA_PERMISSION = 101;

    private WebView mWebView;
    private ProgressBar mProgressBar;
    private SharedPreferences mPrefs;
    private PermissionRequest mCurrentPermissionRequest;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        mPrefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);

        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);

        mProgressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        mProgressBar.setLayoutParams(new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 8));
        mProgressBar.setVisibility(View.GONE);
        layout.addView(mProgressBar);

        mWebView = new WebView(this);
        mWebView.setLayoutParams(new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.MATCH_PARENT));
        layout.addView(mWebView);

        setContentView(layout);

        setupWebView();
        checkPermissions();

        String serverUrl = mPrefs.getString(KEY_SERVER_URL, "");
        if (serverUrl.isEmpty()) {
            promptServerUrl(false);
        } else {
            loadServerUrl(serverUrl);
        }
    }

    private void setupWebView() {
        WebSettings settings = mWebView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);

        mWebView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                mProgressBar.setVisibility(View.VISIBLE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                mProgressBar.setVisibility(View.GONE);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    showErrorDialog(request.getUrl().toString());
                }
            }
        });

        mWebView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                mProgressBar.setProgress(newProgress);
                if (newProgress >= 100) {
                    mProgressBar.setVisibility(View.GONE);
                }
            }

            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                mCurrentPermissionRequest = request;
                for (String resource : request.getResources()) {
                    if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) {
                        if (ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.CAMERA)
                                == PackageManager.PERMISSION_GRANTED) {
                            request.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                        } else {
                            ActivityCompat.requestPermissions(MainActivity.this,
                                    new String[]{Manifest.permission.CAMERA}, REQ_CAMERA_PERMISSION);
                        }
                        return;
                    }
                }
                request.grant(request.getResources());
            }
        });
    }

    private void checkPermissions() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this,
                    new String[]{Manifest.permission.CAMERA}, REQ_CAMERA_PERMISSION);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_CAMERA_PERMISSION && grantResults.length > 0 &&
                grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            if (mCurrentPermissionRequest != null) {
                mCurrentPermissionRequest.grant(new String[]{PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                mCurrentPermissionRequest = null;
            }
        }
    }

    private void loadServerUrl(String url) {
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = "http://" + url;
        }
        mWebView.loadUrl(url);
    }

    private void promptServerUrl(final boolean isChange) {
        AlertDialog.Builder builder = new AlertDialog.Builder(this);
        builder.setTitle("Connect to Central Clinic Server");
        builder.setMessage("Enter the IP address or URL of the central clinic computer (e.g., http://192.168.1.12:3000):");

        final EditText input = new EditText(this);
        String current = mPrefs.getString(KEY_SERVER_URL, "http://192.168.1.12:3000");
        input.setText(current);
        input.setSelection(input.getText().length());
        builder.setView(input);

        builder.setPositiveButton("Connect", new DialogInterface.OnClickListener() {
            @Override
            public void onClick(DialogInterface dialog, int which) {
                String url = input.getText().toString().trim();
                if (!url.isEmpty()) {
                    mPrefs.edit().putString(KEY_SERVER_URL, url).apply();
                    loadServerUrl(url);
                }
            }
        });

        if (isChange) {
            builder.setNegativeButton("Cancel", null);
        } else {
            builder.setCancelable(false);
        }

        builder.show();
    }

    private void showErrorDialog(final String failedUrl) {
        new AlertDialog.Builder(this)
                .setTitle("Clinic Server Unreachable")
                .setMessage("Could not connect to:\n" + failedUrl + "\n\nEnsure this tablet is connected to the clinic Wi-Fi and the central server PC is running.")
                .setPositiveButton("Retry", (dialog, which) -> mWebView.reload())
                .setNeutralButton("Change Server IP", (dialog, which) -> promptServerUrl(true))
                .show();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && mWebView.canGoBack()) {
            mWebView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }
}
