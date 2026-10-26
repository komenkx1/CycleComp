import React
import UIKit

final class SFSymbolView: UIView {
  @objc var symbolName: String = "" {
    didSet { updateSymbol() }
  }

  @objc var symbolTintColor: UIColor? {
    didSet { symbolImageView.tintColor = symbolTintColor ?? tintColor }
  }

  private let symbolImageView = UIImageView()

  override init(frame: CGRect) {
    super.init(frame: frame)
    symbolImageView.contentMode = .scaleAspectFit
    addSubview(symbolImageView)
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    symbolImageView.frame = bounds
  }

  private func updateSymbol() {
    let configuration = UIImage.SymbolConfiguration(pointSize: 18, weight: .semibold)
    symbolImageView.image = UIImage(systemName: symbolName, withConfiguration: configuration)
    symbolImageView.tintColor = symbolTintColor ?? tintColor
    isHidden = symbolImageView.image == nil
  }
}

@objc(SFSymbolViewManager)
final class SFSymbolViewManager: RCTViewManager {
  override func view() -> UIView! {
    SFSymbolView(frame: .zero)
  }

  override static func requiresMainQueueSetup() -> Bool {
    true
  }
}
