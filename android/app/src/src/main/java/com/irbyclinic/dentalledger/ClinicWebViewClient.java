package com.irbyclinic.dentalledger;

import android.graphics.Bitmap;
import android.view.View;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class ClinicWebViewClient extends WebViewClient {

    private final MainActivity mActivity;

    public ClinicWebViewClient(MainActivity activity) {
        this.mActivity = activity;
    }

    @Override
    public void onPageStarted(WebView view, String url, Bitmap favicon) {
        if (mActivity.mProgressBar != null) {
            mActivity.mProgressBar.setVisibility(View.VISIBLE);
        }
    }

    @Override
    public void onPageFinished(WebView view, String url) {
        if (mActivity.mProgressBar != null) {
            mActivity.mProgressBar.setVisibility(View.GONE);
        }
    }

    @Override
    public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        if (request.isForMainFrame()) {
            mActivity.showErrorDialog(request.getUrl().toString());
        }
    }
}
