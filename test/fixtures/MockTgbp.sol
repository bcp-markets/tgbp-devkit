// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Test double for tGBP's StableTokenV1OFT. It keeps the parts the kit
/// depends on: 18 decimals, paused(), isBanned(), and the same custom errors
/// with the same selectors (OpenZeppelin v5 EnforcedPause and
/// ERC20InsufficientBalance, tGBP's Bannable AccountBanned).
contract MockTgbp {
    error EnforcedPause();
    error AccountBanned();
    error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed);

    event Transfer(address indexed from, address indexed to, uint256 value);

    string public constant name = "Tokenised GBP";
    string public constant symbol = "tGBP";
    uint8 public constant decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => bool) public isBanned;
    bool public paused;
    uint256 public totalSupply;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function setPaused(bool value) external {
        paused = value;
    }

    function setBanned(address account, bool value) external {
        isBanned[account] = value;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        if (isBanned[msg.sender] || isBanned[to]) revert AccountBanned();
        if (paused) revert EnforcedPause();
        uint256 balance = balanceOf[msg.sender];
        if (balance < value) revert ERC20InsufficientBalance(msg.sender, balance, value);
        balanceOf[msg.sender] = balance - value;
        balanceOf[to] += value;
        emit Transfer(msg.sender, to, value);
        return true;
    }
}
