const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

class TaskNotifier {
    constructor(logger = console.log) {
        this.logger = logger;
        this.lastNotifyTime = 0;
        this.cooldownMs = 5000;
        this.scriptPath = path.join(os.tmpdir(), 'antigravity_toast.ps1');
    }

    log(...args) {
        if (this.logger) {
            this.logger(`[Notifier] ${args.join(' ')}`);
        }
    }

    /**
     * 发送系统通知：支持【精美 UI 艺术图卡片 (image)】与【原生极清暗黑 UI 弹框 (ui)】双模式自由切换
     */
    notify({ title = "🎉 任务完成", message = "思考与生成已完成 · 点击切回 IDE", playSound = true, style = "image" } = {}) {
        const now = Date.now();
        if (now - this.lastNotifyTime < this.cooldownMs) {
            this.log("通知触发过于频繁，已自动防抖抑制");
            return;
        }
        this.lastNotifyTime = now;

        this.log(`触发系统通知 (模式: ${style}): ${title} - ${message}`);

        const mediaDir = path.join(__dirname, '..', 'media');
        
        // 动态扫描 media 目录下所有编号格式的 card_*.png 图片，实现全量随机轮播
        let availableCardFiles = [];
        try {
            if (fs.existsSync(mediaDir)) {
                availableCardFiles = fs.readdirSync(mediaDir)
                    .filter(f => /^card_\d+\.png$/i.test(f));
            }
        } catch (e) { }

        // 若没有找到编号卡片，则回退到备选图片
        if (availableCardFiles.length === 0) {
            if (fs.existsSync(path.join(mediaDir, 'notification_card.png'))) {
                availableCardFiles.push('notification_card.png');
            }
        }

        const chosenFile = availableCardFiles.length > 0
            ? availableCardFiles[Math.floor(Math.random() * availableCardFiles.length)]
            : 'card_1.png';

        const targetImagePath = path.join(mediaDir, chosenFile).replace(/\\/g, '\\\\');

        let xamlBody = '';
        let winH = 180;
        let winW = 380;

        if (style === 'image' && fs.existsSync(path.join(mediaDir, chosenFile))) {
            // 模式 1：随机轮播高奢艺术卡片（全画幅 · 极清悬浮 · 柔光弥散）
            winH = 180;
            winW = 380;
            xamlBody = `
    <Border CornerRadius="16" 
            Cursor="Hand"
            Margin="8"
            BorderThickness="0"
            ClipToBounds="True"
            Background="#0B0D14">
        <Border.Effect>
            <DropShadowEffect Color="#38BDF8" BlurRadius="24" ShadowDepth="0" Opacity="0.45"/>
        </Border.Effect>
        <Grid>
            <Image Source="${targetImagePath}" 
                   Stretch="UniformToFill" 
                   HorizontalAlignment="Center" 
                   VerticalAlignment="Center"/>
        </Grid>
    </Border>`;
        } else {
            // 模式 2：原生极清暗黑毛玻璃 UI 弹框（彩色高保真矢量拉花 + 科技流光条）
            winH = 110;
            winW = 380;
            xamlBody = `
    <Border Background="#1A1B23" 
            BorderBrush="#2D3139" 
            BorderThickness="1" 
            CornerRadius="12" 
            Cursor="Hand"
            Margin="6">
        <Border.Effect>
            <DropShadowEffect Color="#000000" BlurRadius="16" ShadowDepth="4" Opacity="0.55"/>
        </Border.Effect>
        <Grid>
            <!-- 左侧渐变发光线条 -->
            <Border Width="4" 
                    HorizontalAlignment="Left" 
                    CornerRadius="12,0,0,12">
                <Border.Background>
                    <LinearGradientBrush StartPoint="0,0" EndPoint="0,1">
                        <GradientStop Color="#00D2FF" Offset="0.0"/>
                        <GradientStop Color="#0078D4" Offset="1.0"/>
                    </LinearGradientBrush>
                </Border.Background>
            </Border>
            
            <Grid Margin="20,12,18,12">
                <Grid.RowDefinitions>
                    <RowDefinition Height="Auto"/>
                    <RowDefinition Height="*"/>
                </Grid.RowDefinitions>
                
                <!-- 顶部标题栏 -->
                <Grid Grid.Row="0">
                    <StackPanel Orientation="Horizontal" VerticalAlignment="Center">
                        <!-- 彩色矢量庆祝拉花图标 (解决 Windows WPF 默认单色 Emoji 变黑的问题) -->
                        <Viewbox Width="18" Height="18" Margin="0,0,8,0" VerticalAlignment="Center">
                            <Canvas Width="24" Height="24">
                                <!-- 锥筒筒身：金色渐变 -->
                                <Path Data="M 3,21 L 11,9 L 15,13 Z">
                                    <Path.Fill>
                                        <LinearGradientBrush StartPoint="0,1" EndPoint="1,0">
                                            <GradientStop Color="#FF9800" Offset="0"/>
                                            <GradientStop Color="#FFEB3B" Offset="1"/>
                                        </LinearGradientBrush>
                                    </Path.Fill>
                                </Path>
                                <!-- 彩带条纹与纸屑 -->
                                <Path Data="M 7,15 L 13,11" Stroke="#E91E63" StrokeThickness="1.5" StrokeStartLineCap="Round" StrokeEndLineCap="Round"/>
                                <!-- 喷射出的彩色星星与碎纸屑 -->
                                <Path Data="M 13,4 L 14,7 L 17,7 L 14.5,9 L 15.5,12 L 13,10 L 10.5,12 L 11.5,9 L 9,7 L 12,7 Z" Fill="#FFD700"/>
                                <Ellipse Canvas.Left="19" Canvas.Top="4" Width="2.5" Height="2.5" Fill="#00E5FF"/>
                                <Ellipse Canvas.Left="17" Canvas.Top="13" Width="3" Height="3" Fill="#FF4081"/>
                                <Ellipse Canvas.Left="10" Canvas.Top="2" Width="2.5" Height="2.5" Fill="#76FF03"/>
                                <Path Data="M 18,8 C 21,7 21,11 23,10" Stroke="#FF5252" StrokeThickness="1.2" Fill="Transparent"/>
                                <Path Data="M 14,2 C 16,1 17,4 19,3" Stroke="#7C4DFF" StrokeThickness="1.2" Fill="Transparent"/>
                            </Canvas>
                        </Viewbox>
                        
                        <TextBlock Text="${title.replace('🎉', '').trim()}" 
                                   FontFamily="Microsoft YaHei UI, Segoe UI" 
                                   FontSize="14" 
                                   FontWeight="SemiBold" 
                                   Foreground="#F3F4F6" 
                                   VerticalAlignment="Center"/>
                    </StackPanel>
                    
                    <Border Background="#16FFFFFF" 
                            CornerRadius="4" 
                            Padding="6,2" 
                            HorizontalAlignment="Right" 
                            VerticalAlignment="Center">
                        <TextBlock Text="Antigravity" 
                                   FontFamily="Segoe UI" 
                                   FontSize="10" 
                                   FontWeight="Medium" 
                                   Foreground="#9CA3AF"/>
                    </Border>
                </Grid>
                
                <!-- 消息内容与引导按钮 -->
                <Grid Grid.Row="1" Margin="0,8,0,0">
                    <TextBlock FontFamily="Microsoft YaHei UI, Segoe UI" 
                               FontSize="12" 
                               Foreground="#94A3B8" 
                               TextWrapping="Wrap" 
                               Text="${message.replace(/"/g, '&quot;')}"
                               VerticalAlignment="Center"
                               Margin="0,0,85,0"/>
                    
                    <Border Background="#1A00A2ED" 
                            BorderBrush="#3300A2ED" 
                            BorderThickness="1" 
                            CornerRadius="6" 
                            Padding="8,4" 
                            HorizontalAlignment="Right" 
                            VerticalAlignment="Center">
                        <TextBlock FontFamily="Microsoft YaHei UI, Segoe UI" 
                                   FontSize="11" 
                                   FontWeight="SemiBold" 
                                   Foreground="#38BDF8" 
                                   Text="点击切回 →"/>
                    </Border>
                </Grid>
            </Grid>
        </Grid>
    </Border>`;
        }

        const psContent = `
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$win32Code = @"
using System;
using System.Runtime.InteropServices;
public class Win32Helper {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);
}
"@
Add-Type -TypeDefinition $win32Code -ErrorAction SilentlyContinue

[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Antigravity Notification"
        Height="${winH}" Width="${winW}"
        WindowStyle="None"
        AllowsTransparency="True"
        Background="Transparent"
        Topmost="True"
        ShowInTaskbar="False"
        WindowStartupLocation="Manual"
        Opacity="0"
        TextOptions.TextFormattingMode="Display"
        TextOptions.TextRenderingMode="ClearType"
        RenderOptions.ClearTypeHint="Enabled">
    <Window.Triggers>
        <EventTrigger RoutedEvent="Window.Loaded">
            <BeginStoryboard>
                <Storyboard>
                    <DoubleAnimation Storyboard.TargetProperty="Opacity"
                                     From="0" To="1" Duration="0:0:0.25">
                        <DoubleAnimation.EasingFunction>
                            <CubicEase EasingMode="EaseOut"/>
                        </DoubleAnimation.EasingFunction>
                    </DoubleAnimation>
                </Storyboard>
            </BeginStoryboard>
        </EventTrigger>
    </Window.Triggers>
    ${xamlBody}
</Window>
"@

$reader = (New-Object System.Xml.XmlNodeReader $xaml)
$window = [System.Windows.Markup.XamlReader]::Load($reader)

# 计算工作区右下角位置
$workArea = [System.Windows.SystemParameters]::WorkArea
$window.Left = $workArea.Right - $window.Width - 16
$window.Top = $workArea.Bottom - $window.Height - 16

$action = {
    $processes = Get-Process -Name "Antigravity", "Cursor", "Code" -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
    if ($processes) {
        $hwnd = $processes[0].MainWindowHandle
        if ([Win32Helper]::IsIconic($hwnd)) {
            [Win32Helper]::ShowWindowAsync($hwnd, 9) | Out-Null
        }
        [Win32Helper]::SetForegroundWindow($hwnd) | Out-Null
    }
    $window.Close()
}

$window.Add_MouseLeftButtonDown($action)

# 8 秒无操作自动淡出关闭
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds(8)
$timer.Add_Tick({
    $timer.Stop()
    $window.Close()
})
$timer.Start()

$window.ShowDialog() | Out-Null
`;

        try {
            fs.writeFileSync(this.scriptPath, '\uFEFF' + psContent, 'utf8');
            
            if (playSound) {
                try {
                    const soundPs = `[System.Media.SystemSounds]::Asterisk.Play()`;
                    spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', soundPs], {
                        windowsHide: true,
                        detached: true,
                        stdio: 'ignore'
                    }).unref();
                } catch (e) { }
            }

            const child = spawn('powershell.exe', ['-Sta', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', this.scriptPath], {
                windowsHide: true,
                detached: false
            });

            child.on('error', (err) => {
                this.log(`WPF Toast 启动错误: ${err.message}`);
            });

            this.log(`WPF Toast (${style}) 通知已呈现`);
        } catch (err) {
            this.log(`启动通知失败: ${err.message}`);
        }
    }
}

module.exports = { TaskNotifier };
