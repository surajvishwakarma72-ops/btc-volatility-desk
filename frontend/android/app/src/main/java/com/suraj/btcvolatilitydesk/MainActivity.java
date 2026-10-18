package com.suraj.btcvolatilitydesk;

import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        
        // Enable remote webview debugging via chrome://inspect
        WebView.setWebContentsDebuggingEnabled(true);
    }
}
