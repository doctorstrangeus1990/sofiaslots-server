import pyautogui
import time

# Give yourself time to click on the IPMI console window
print("You have 5 seconds to click on the IPMI console window...")
time.sleep(5)

def slow_type(text, delay=0.1):
    for char in text:
        pyautogui.write(char, interval=delay)
        time.sleep(0.05)

# Type username
print("Typing username...")
slow_type('admin')
pyautogui.press('enter')
time.sleep(2)  # Wait for password prompt

# Type password
print("Typing password...")
slow_type('beluckyAdminsX$447F5@nGO')
pyautogui.press('enter')
time.sleep(3)  # Wait for login

# Now type your command
print("Typing command...")
slow_type('systemctl status sshd')
pyautogui.press('enter')