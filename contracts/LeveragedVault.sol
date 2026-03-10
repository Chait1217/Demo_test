// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title LeveragedVault
 * @notice Minimal USDC.e vault for leveraged prediction markets.
 *         - Accepts USDC.e deposits and mints 1:1 vault shares.
 *         - Tracks total borrowed liquidity and utilization.
 *         - Exposes borrow/repay for a designated margin engine (owner by default).
 *
 *         This is intentionally simple and focused on accounting for a single market.
 */
contract LeveragedVault is Ownable {
    IERC20 public immutable asset; // USDC.e

    mapping(address => uint256) public balanceOf;
    uint256 public totalShares;
    uint256 public totalBorrowed;

    address public marginEngine;

    event Deposit(address indexed from, address indexed receiver, uint256 assets, uint256 shares);
    event Withdraw(address indexed owner, address indexed receiver, uint256 assets, uint256 shares);
    event Borrow(address indexed engine, uint256 amount);
    event Repay(address indexed engine, uint256 amount);

    constructor(address _asset, address _owner) Ownable(_owner) {
        require(_asset != address(0), "asset required");
        asset = IERC20(_asset);
        marginEngine = _owner;
    }

    modifier onlyEngine() {
        require(msg.sender == marginEngine, "not engine");
        _;
    }

    function setMarginEngine(address engine) external onlyOwner {
        require(engine != address(0), "engine required");
        marginEngine = engine;
    }

    // --- Views ---

    function totalAssets() public view returns (uint256) {
        return asset.balanceOf(address(this)) + totalBorrowed;
    }

    function availableLiquidity() public view returns (uint256) {
        return asset.balanceOf(address(this));
    }

    function utilization() public view returns (uint256) {
        uint256 tvl = totalAssets();
        if (tvl == 0) return 0;
        return (totalBorrowed * 1e18) / tvl;
    }

    function maxWithdraw(address owner_) public view returns (uint256) {
        uint256 shares = balanceOf[owner_];
        if (shares == 0) return 0;
        uint256 tvl = totalAssets();
        if (tvl == 0) return 0;
        uint256 ownerAssets = (shares * tvl) / totalShares;
        uint256 liquid = availableLiquidity();
        return ownerAssets > liquid ? liquid : ownerAssets;
    }

    // --- User actions ---

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        require(assets > 0, "zero assets");
        uint256 tvl = totalAssets();
        if (tvl == 0 || totalShares == 0) {
            shares = assets;
        } else {
            shares = (assets * totalShares) / tvl;
        }

        require(asset.transferFrom(msg.sender, address(this), assets), "transfer failed");

        balanceOf[receiver] += shares;
        totalShares += shares;

        emit Deposit(msg.sender, receiver, assets, shares);
    }

    function withdraw(uint256 assets, address receiver, address owner_) external returns (uint256 shares) {
        require(assets > 0, "zero assets");
        uint256 maxAssets = maxWithdraw(owner_);
        require(assets <= maxAssets, "insufficient liquidity");

        uint256 tvl = totalAssets();
        shares = (assets * totalShares) / tvl;

        if (msg.sender != owner_) {
            // no allowance pattern for simplicity; assume owner calls
            revert("only owner");
        }

        balanceOf[owner_] -= shares;
        totalShares -= shares;

        require(asset.transfer(receiver, assets), "transfer failed");

        emit Withdraw(owner_, receiver, assets, shares);
    }

    // --- Margin engine hooks ---

    function borrow(uint256 amount) external onlyEngine {
        require(amount > 0, "zero amount");
        require(amount <= availableLiquidity(), "not enough liquidity");

        totalBorrowed += amount;
        require(asset.transfer(msg.sender, amount), "transfer failed");

        emit Borrow(msg.sender, amount);
    }

    function repay(uint256 amount) external onlyEngine {
        require(amount > 0, "zero amount");
        require(asset.transferFrom(msg.sender, address(this), amount), "transfer failed");

        if (amount > totalBorrowed) {
          totalBorrowed = 0;
        } else {
          totalBorrowed -= amount;
        }

        emit Repay(msg.sender, amount);
    }
}

